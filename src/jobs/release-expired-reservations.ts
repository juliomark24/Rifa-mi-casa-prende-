// Job `release-expired-reservations` (plan §2.1, §1.2; docs/jobs.md §1).
// Corre cada minuto. El runner de jobs (S8) lo conecta con runJob();
// este módulo solo expone el nombre y el trabajo, sin registrar JobRun
// aquí (evita doble registro si S8 lo envuelve con runJob).
// Idempotente por reservationId: re-ejecutarlo no libera dos veces.
import { releaseExpiredReservations, type ReleaseResult } from "@/lib/reservations";

export const JOB_NAME = "release-expired-reservations";

export async function run(now = new Date()): Promise<ReleaseResult> {
  return releaseExpiredReservations(now);
}
