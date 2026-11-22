// Job `commission-retention` (S6; plan §2.4, docs/jobs.md §5).
// Mueve comisiones PENDING → RETAINED: la comisión entra en retención
// en cuanto se genera; el período de riesgo lo cierra `retention-sweep`
// (S8, RETAINED → AVAILABLE cuando pasan RETENTION_DAYS —defecto 7— Y
// la rifa está cerrada o su sorteo ya pasó, lo que ocurra después).
// Idempotente por comisión: la segunda pasada no encuentra PENDING.
// Registrar en KNOWN_JOBS + JOB_MODULE_FILES (src/lib/jobs.ts) — lo hace
// el coordinador (S6 no toca jobs.ts).
import { retainDueCommissions } from "../lib/affiliates";
import { db } from "../lib/db";
import type { JobHandler, JobResult } from "../lib/jobs";

export const JOB_NAME = "commission-retention";
export const jobName = JOB_NAME;

export async function run(now = new Date()): Promise<JobResult & { moved: number; commissionIds: string[] }> {
  const result = await retainDueCommissions(db, now);
  return { ok: true, ...result };
}

export const handler: JobHandler = async () => run();
