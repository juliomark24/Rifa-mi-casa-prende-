export const instant = false;

import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { NotificationItem } from "@/components/types";
import { formatDate, statusLabel } from "@/components/format";

/**
 * Notificaciones (plan §2.16): cola con reintentos, registro de entregas
 * y control de duplicados. GET /api/admin/notifications.
 * Si el envío falla, la venta sigue y la notificación se reintenta en
 * segundo plano; el fallo queda registrado.
 */
export default async function AdminNotificationsPage() {
  let items: NotificationItem[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/notifications?limit=100");
    if (!res.ok) loadError = true;
    else items = asArray<NotificationItem>(await res.json(), "notifications");
  } catch {
    loadError = true;
  }

  const counts = items.reduce<Record<string, number>>((acc, n) => {
    acc[n.status] = (acc[n.status] ?? 0) + 1;
    return acc;
  }, {});
  const failed = items.filter((n) => n.status === "FALLIDO" || n.status === "FAILED");

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Notificaciones</h2>
      <p className="mt-1 text-sm text-stone-600">
        Cola de envíos (correo, WhatsApp, web) con reintentos y registro de entregas. Un evento genera una
        notificación por destinatario y canal, no varias.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar la cola de notificaciones en este momento.
        </div>
      )}

      {!loadError && (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Total en cola", String(items.length)],
              ["Entregadas", String((counts.ENTREGADO ?? 0) + (counts.DELIVERED ?? 0))],
              ["Enviadas", String((counts.ENVIADO ?? 0) + (counts.SENT ?? 0))],
              ["Fallidas", String(failed.length)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</p>
                <p className="mt-1 text-2xl font-black text-stone-900">{value}</p>
              </div>
            ))}
          </div>

          {failed.length > 0 && (
            <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-5" role="alert">
              <h3 className="font-bold text-rose-900">Entregas fallidas ({failed.length})</h3>
              <p className="mt-1 text-sm text-rose-800">
                Se reintentan automáticamente en segundo plano. Si el fallo persiste, genera alerta al admin.
              </p>
            </div>
          )}

          {items.length === 0 ? (
            <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
              No hay notificaciones registradas todavía.
            </p>
          ) : (
            <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="w-full min-w-175 text-left text-sm">
                <thead className="bg-stone-50 text-xs uppercase text-stone-500">
                  <tr>
                    <th className="px-4 py-3">Evento</th>
                    <th className="px-4 py-3">Canal</th>
                    <th className="px-4 py-3">Destinatario</th>
                    <th className="px-4 py-3">Estado</th>
                    <th className="px-4 py-3">Intentos</th>
                    <th className="px-4 py-3">Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((n) => (
                    <tr key={n.id} className="border-t border-stone-100">
                      <td className="px-4 py-3 font-medium">{n.event ?? "—"}</td>
                      <td className="px-4 py-3">{n.channel ?? "—"}</td>
                      <td className="px-4 py-3 text-xs">{n.recipient ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-bold ${
                            n.status === "ENTREGADO" || n.status === "DELIVERED"
                              ? "bg-emerald-100 text-emerald-800"
                              : n.status === "FALLIDO" || n.status === "FAILED"
                                ? "bg-rose-100 text-rose-800"
                                : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {statusLabel(n.status)}
                        </span>
                        {n.lastError && <span className="block text-xs text-rose-700">{n.lastError}</span>}
                      </td>
                      <td className="px-4 py-3">{n.attempts ?? "—"}</td>
                      <td className="px-4 py-3">{formatDate(n.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
