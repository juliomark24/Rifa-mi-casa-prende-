// Job `fraud-scan` (S6; plan §2.14).
// Escanea pedidos recientes y aplica las reglas de fraude (velocidad,
// auto-referido, reembolsos/contracargos repetidos) + gestiona los
// contracargos abiertos en conciliación (S5 solo abre el caso: aquí se
// marca pedido/afiliado en Revisión y se abre el caso de fraude).
// Idempotente: flagForReview no duplica casos abiertos (misma regla +
// entidad). Registrar en KNOWN_JOBS + JOB_MODULE_FILES (src/lib/jobs.ts)
// — lo hace el coordinador (S6 no toca jobs.ts).
import { scanRecentOrders } from "../lib/fraud";
import type { JobHandler, JobResult } from "../lib/jobs";

export const JOB_NAME = "fraud-scan";
export const jobName = JOB_NAME;

export async function run(now = new Date()): Promise<JobResult & { scanned: number; flagged: number; rules: Record<string, number> }> {
  const result = await scanRecentOrders({ sinceMinutes: 60, now });
  return { ok: true, ...result };
}

export const handler: JobHandler = async () => run();
