export const instant = false;

import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { Raffle, Ticket } from "@/components/types";
import { formatDate, statusLabel } from "@/components/format";
import { TicketBlockActions, TicketUnblockButton } from "@/components/AdminActions";


/** GET /api/admin/tickets?raffleId= */
export default async function AdminTicketsPage({ searchParams }: { searchParams: Promise<{ raffleId?: string }> }) {
  const { raffleId } = await searchParams;
  let tickets: Ticket[] = [];
  let raffles: Raffle[] = [];
  let loadError = false;
  try {
    const [ticketsRes, rafflesRes] = await Promise.all([
      serverFetch(raffleId ? `/api/admin/tickets?raffleId=${encodeURIComponent(raffleId)}` : "/api/admin/tickets"),
      serverFetch("/api/raffles?status=ACTIVA"),
    ]);
    if (!ticketsRes.ok) loadError = true;
    else tickets = asArray<Ticket>(await ticketsRes.json(), "tickets");
    if (rafflesRes.ok) raffles = asArray<Raffle>(await rafflesRes.json(), "raffles");
  } catch {
    loadError = true;
  }

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Boletos</h2>
      <p className="mt-1 text-sm text-stone-600">
        Bloquea, desbloquea o anula boletos por rifa. Anular exige motivo y queda en el historial; si el boleto
        estaba pagado, la anulación dispara el reembolso.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
        <label className="block text-sm font-medium text-stone-700">
          Filtrar por rifa
          <select name="raffleId" defaultValue={raffleId ?? ""} className="mt-1 rounded-lg border border-stone-300 px-3 py-2 text-sm">
            <option value="">Todas las rifas</option>
            {raffles.map((r) => (
              <option key={r.id} value={r.id}>{r.title}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-700">
          Filtrar
        </button>
      </form>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los boletos en este momento.
        </div>
      )}

      {!loadError && tickets.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
          No hay boletos para mostrar. Elige una rifa con el filtro de arriba.
        </p>
      )}

      {tickets.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-175 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3">Código</th>
                <th className="px-4 py-3">Número</th>
                <th className="px-4 py-3">Comprador</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} className="border-t border-stone-100">
                  <td className="px-4 py-3 font-mono text-xs font-bold">{t.code}</td>
                  <td className="px-4 py-3">#{t.number}</td>
                  <td className="px-4 py-3">{t.buyerName ?? "—"}</td>
                  <td className="px-4 py-3">{statusLabel(t.status)}</td>
                  <td className="px-4 py-3">{formatDate(t.createdAt)}</td>
                  <td className="px-4 py-3">
                    {(t.status as string) === "BLOQUEADO" ? (
                      <TicketUnblockButton id={t.id} />
                    ) : (
                      <TicketBlockActions id={t.id} status={t.status} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
