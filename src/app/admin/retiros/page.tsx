export const instant = false;

import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { Withdrawal } from "@/components/types";
import { formatDate, formatMoney, statusLabel } from "@/components/format";
import { WithdrawalActions } from "@/components/AdminActions";


/** GET /api/admin/withdrawals */
export default async function AdminWithdrawalsPage() {
  let withdrawals: Withdrawal[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/withdrawals");
    if (!res.ok) loadError = true;
    else withdrawals = asArray<Withdrawal>(await res.json(), "withdrawals");
  } catch {
    loadError = true;
  }

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Retiros</h2>
      <p className="mt-1 text-sm text-stone-600">Solicitudes de retiro de los afiliados. Marca como pagado tras realizar el pago.</p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los retiros en este momento.
        </div>
      )}

      {!loadError && withdrawals.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">No hay solicitudes de retiro.</p>
      )}

      {withdrawals.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-175 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3">Afiliado</th>
                <th className="px-4 py-3">Monto</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr key={w.id} className="border-t border-stone-100">
                  <td className="px-4 py-3">
                    {w.affiliate ? (
                      <>
                        <p className="font-medium">{w.affiliate.name}</p>
                        <p className="text-xs text-stone-500">{w.affiliate.email}</p>
                      </>
                    ) : (
                      <span className="font-mono text-xs">{w.affiliateId}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold">{formatMoney(w.amount)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${w.status === "PAGADO" || w.status === "PAID" ? "bg-emerald-100 text-emerald-800" : w.status === "RECHAZADO" || w.status === "REJECTED" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"}`}>
                      {statusLabel(w.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">{formatDate(w.createdAt)}</td>
                  <td className="px-4 py-3">
                    {w.status === "REQUESTED" || w.status === "SOLICITADO" ? <WithdrawalActions id={w.id} /> : <span className="text-xs text-stone-400">—</span>}
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
