// Runner de jobs resistentes (plan regla 3, §2.19): cada ejecución registra
// JobRun (inicio, fin, resultado, error), es idempotente y re-ejecutable.
// Si ya hay una ejecución RUNNING reciente del mismo job, se salta (evita
// duplicados tras reinicios o solapamientos de cron).
//
// Extensión S8:
//  - `recoverStaleJobRuns()`: recuperación tras reinicio — marca FAILED
//    las ejecuciones RUNNING huérfanas (sin finishedAt) para que la
//    siguiente ejecución programada retome el trabajo pendiente desde
//    el estado en BD (nunca desde memoria).
//  - `runJobByName()` / `runAllJobs()`: descubrimiento tolerante — el
//    runner importa dinámicamente los módulos de src/jobs/*.ts si
//    existen; si un módulo falta (ej. S4/S5 aún no implementados), se
//    registra como MISSING y se sigue con los demás, sin tumbar el runner.
//    Convención de cada módulo: exporta `jobName` y `handler(ctx)`.
//    (También se acepta `default` como handler.)
import { db } from "./db";

export type JobResult = { ok: boolean; [key: string]: unknown };
export type JobHandler = (ctx: { jobRunId: string }) => Promise<JobResult>;

const DEFAULT_LOCK_MS = 5 * 60 * 1000; // una ejecución no debería durar más

export async function runJob(
  job: string,
  handler: JobHandler,
  opts?: { lockMs?: number },
): Promise<{ jobRunId: string; status: string; result?: JobResult; skipped?: boolean }> {
  const lockMs = opts?.lockMs ?? DEFAULT_LOCK_MS;
  const running = await db.jobRun.findFirst({
    where: {
      job,
      status: "RUNNING",
      startedAt: { gte: new Date(Date.now() - lockMs) },
    },
    orderBy: { startedAt: "desc" },
  });
  if (running) {
    return { jobRunId: running.id, status: "RUNNING", skipped: true };
  }
  // Ejecuciones RUNNING huérfanas (más viejas que el lock) se marcan FAILED
  // para no bloquear futuras ejecuciones.
  await recoverStaleJobRuns(job, lockMs);

  const jobRun = await db.jobRun.create({ data: { job, status: "RUNNING" } });
  try {
    const result = await handler({ jobRunId: jobRun.id });
    await db.jobRun.update({
      where: { id: jobRun.id },
      data: { status: "COMPLETED", finishedAt: new Date(), result: result as object },
    });
    return { jobRunId: jobRun.id, status: "COMPLETED", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.jobRun.update({
      where: { id: jobRun.id },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    throw err;
  }
}

export async function getLastJobRun(job: string) {
  return db.jobRun.findFirst({ where: { job }, orderBy: { startedAt: "desc" } });
}

/**
 * Recuperación tras reinicio (docs/jobs.md): marca FAILED las ejecuciones
 * RUNNING huérfanas (empezaron hace más de `lockMs` y nunca terminaron,
 * típico de un reinicio a mitad de ejecución). La siguiente ejecución
 * programada retoma el trabajo pendiente desde el estado en BD.
 * Devuelve cuántas ejecuciones se recuperaron.
 */
export async function recoverStaleJobRuns(job?: string, lockMs: number = DEFAULT_LOCK_MS) {
  const res = await db.jobRun.updateMany({
    where: {
      ...(job ? { job } : {}),
      status: "RUNNING",
      startedAt: { lt: new Date(Date.now() - lockMs) },
    },
    data: { status: "FAILED", finishedAt: new Date(), error: "Ejecución huérfana (reinicio/timeout)" },
  });
  return res.count;
}

// ---------------------------------------------------------------- descubrimiento
/** Jobs conocidos del sistema (contrato API-CONTRACT-v2.2.md § Jobs). */
export const KNOWN_JOBS = [
  "release-expired-reservations",
  "reconcile-provider",
  "expire-pending-orders",
  "commission-retention",
  "compensate-paid-commissions",
  "fraud-scan",
  "notification-dispatch",
  "backup-daily",
  "recovery-sweep",
  "retention-sweep",
] as const;

export type KnownJobName = (typeof KNOWN_JOBS)[number];

/** Módulo en src/jobs/ que implementa cada job (S4/S5 pueden no existir aún). */
const JOB_MODULE_FILES: Record<string, string> = {
  "release-expired-reservations": "release-expired-reservations",
  "reconcile-provider": "reconcile-provider",
  "expire-pending-orders": "expire-pending-orders",
  "commission-retention": "commission-retention",
  "compensate-paid-commissions": "compensate-paid-commissions",
  "fraud-scan": "fraud-scan",
  "notification-dispatch": "notification-dispatch",
  "backup-daily": "backup",
  "recovery-sweep": "recovery-sweep",
  "retention-sweep": "retention-sweep",
};

export type JobDiscoveryResult = {
  jobRunId: string;
  status: string;
  result?: JobResult;
  skipped?: boolean;
  /** El módulo del job no existe todavía (otra subfase lo implementa). */
  missing?: boolean;
  reason?: string;
};

/**
 * Ejecuta un job por nombre, importando su módulo dinámicamente.
 * Si el módulo falta o no exporta handler, devuelve MISSING/NO_HANDLER
 * sin lanzar: el runner tolera jobs aún no implementados (S4, S5).
 */
export async function runJobByName(
  job: string,
  opts?: { lockMs?: number },
): Promise<JobDiscoveryResult> {
  const file = JOB_MODULE_FILES[job] ?? job;
  let mod: {
    handler?: JobHandler;
    default?: JobHandler;
    run?: () => Promise<JobResult>;
    jobName?: string;
    JOB_NAME?: string;
  };
  try {
    // Import dinámico con nombre calculado: si el archivo no existe, el
    // import rechaza y se registra como MISSING (no se cae el runner).
    mod = (await import(/* @vite-ignore */ `../jobs/${file}`)) as {
      handler?: JobHandler;
      default?: JobHandler;
      run?: () => Promise<JobResult>;
      jobName?: string;
      JOB_NAME?: string;
    };
  } catch (err) {
    return {
      jobRunId: "",
      status: "MISSING",
      skipped: true,
      missing: true,
      reason: `Módulo src/jobs/${file}.ts no existe todavía: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Convención S8: `handler(ctx)` o `default`. También se acepta `run()`
  // (convención del módulo de S4: `run(now?)` sin contexto de JobRun).
  const handler: JobHandler | undefined =
    mod.handler ??
    mod.default ??
    (typeof mod.run === "function"
      ? async () => {
          const result = (await mod.run!()) as JobResult;
          return { ...result, ok: result.ok ?? true };
        }
      : undefined);
  if (typeof handler !== "function") {
    return {
      jobRunId: "",
      status: "NO_HANDLER",
      skipped: true,
      missing: true,
      reason: `Módulo src/jobs/${file}.ts no exporta handler()`,
    };
  }
  return runJob(job, handler, opts);
}

/**
 * Ejecuta todos los jobs conocidos (p. ej. desde el cron interno del
 * servidor). Nunca lanza: cada fallo queda en su JobRun y en el resumen.
 */
export async function runAllJobs(): Promise<{
  completed: string[];
  failed: Array<{ job: string; error: string }>;
  skipped: Array<{ job: string; status: string; reason?: string }>;
}> {
  const completed: string[] = [];
  const failed: Array<{ job: string; error: string }> = [];
  const skipped: Array<{ job: string; status: string; reason?: string }> = [];
  for (const job of KNOWN_JOBS) {
    try {
      const res = await runJobByName(job);
      if (res.skipped) {
        skipped.push({ job, status: res.status, reason: res.reason });
      } else if (res.status === "COMPLETED") {
        completed.push(job);
      } else {
        skipped.push({ job, status: res.status });
      }
    } catch (err) {
      failed.push({ job, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { completed, failed, skipped };
}
