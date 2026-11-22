// Job `notification-dispatch` (continuo; plan §2.16, docs/jobs.md §3).
// Procesa la cola de notificaciones con reintentos y backoff.
// Nunca rompe la compra: el despacho corre desacoplado y cada fallo
// queda registrado en la fila de la notificación.
import { dispatchPendingNotifications } from "../lib/notifications";
import type { JobHandler } from "../lib/jobs";

export const jobName = "notification-dispatch";

export const handler: JobHandler = async () => {
  const result = await dispatchPendingNotifications({ limit: 50 });
  return { ok: result.failed === 0, ...result };
};
