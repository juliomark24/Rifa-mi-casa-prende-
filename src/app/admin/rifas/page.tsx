export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { Raffle } from "@/components/types";
import { formatDate, formatMoney, percentSoldOf, statusLabel } from "@/components/format";
import { RaffleTransition } from "@/components/AdminActions";


/** GET /api/admin/raffles — lista de administración (todos los estados). */
export default async function AdminRafflesPage() {
  let raffles: Raffle[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/raffles?limit=100");
    if (!res.ok) loadError = true;
    else raffles = asArray<Raffle>(await res.json(), "raffles");
  } catch {
    loadError = true;
  }
  raffles = [...raffles].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-black text-stone-900">Rifas</h2>
        <Link href="/admin/rifas/nueva" className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-700">
          + Nueva rifa
        </Link>
      </div>
      <p className="mt-1 text-sm text-stone-600">
        Ciclo de vida de 11 estados. El cambio de estado se hace con la transición permitida; cancelar una rifa
        activa el flujo de reembolsos.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar las rifas en este momento.
        </div>
      )}

      {!loadError && raffles.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
          No hay rifas todavía. Crea la primera con el botón “Nueva rifa”.
        </p>
      )}

      {raffles.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-175 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3">Rifa</th>
                <th className="px-4 py-3">Precio</th>
                <th className="px-4 py-3">Vendidos</th>
                <th className="px-4 py-3">Sorteo</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Transición</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {raffles.map((r) => (
                <tr key={r.id} className="border-t border-stone-100">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-stone-900">{r.title}</p>
                    <p className="text-xs text-stone-500">{r.prize} · {r.country} · {r.currency}</p>
                  </td>
                  <td className="px-4 py-3">{formatMoney(r.ticketPrice, r.currency)}</td>
                  <td className="px-4 py-3">{percentSoldOf(r)}% ({r.soldCount ?? r.soldNumbers?.length ?? 0}/{r.totalTickets})</td>
                  <td className="px-4 py-3">{formatDate(r.drawAt)}</td>
                  <td className="px-4 py-3">{statusLabel(r.status)}</td>
                  <td className="px-4 py-3">
                    <RaffleTransition id={r.id} status={r.status} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-2">
                      <Link href={`/rifas/${r.id}`} className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                        Ver
                      </Link>
                      <Link href={`/admin/rifas/${r.id}/editar`} className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                        Editar
                      </Link>
                    </span>
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
