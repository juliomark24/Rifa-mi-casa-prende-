export const instant = false;

import { getBaseUrl, serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { AdminAffiliate } from "@/components/types";
import { formatMoney } from "@/components/format";


/** GET /api/admin/affiliates — devuelve AffiliateSummary (ver
 * getAffiliateSummary): `affiliateId`, `commissions: {pending, retained,
 * available, paid, adjusted}` y `balance` como objeto. S9-int: la página
 * leía `id`, `commissionPending` (número) y `balance` (número), así que
 * todas las celdas de comisiones/saldo salían "—" o NaN. */
export default async function AdminAffiliatesPage() {
  let affiliates: AdminAffiliate[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/affiliates");
    if (!res.ok) loadError = true;
    else affiliates = asArray<AdminAffiliate>(await res.json(), "affiliates");
  } catch {
    loadError = true;
  }

  const availableOf = (a: AdminAffiliate): number | undefined =>
    typeof a.balance === "number" ? a.balance : a.balance?.availableForNewWithdrawal ?? a.balance?.available;

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Afiliados</h2>
      <p className="mt-1 text-sm text-stone-600">Afiliados registrados, sus clics, ventas y comisiones.</p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los afiliados en este momento.
        </div>
      )}

      {!loadError && affiliates.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">No hay afiliados registrados todavía.</p>
      )}

      {affiliates.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-200 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3">Afiliado</th>
                <th className="px-4 py-3">Código</th>
                <th className="px-4 py-3">Link</th>
                <th className="px-4 py-3">Clics</th>
                <th className="px-4 py-3">Ventas</th>
                <th className="px-4 py-3">Pendiente</th>
                <th className="px-4 py-3">Retenido</th>
                <th className="px-4 py-3">Disponible</th>
                <th className="px-4 py-3">Pagado</th>
                <th className="px-4 py-3">Saldo retirable</th>
                <th className="px-4 py-3">Riesgo</th>
              </tr>
            </thead>
            <tbody>
              {affiliates.map((a) => (
                <tr key={a.affiliateId ?? a.id ?? a.email} className="border-t border-stone-100">
                  <td className="px-4 py-3">
                    <p className="font-medium">{a.name}</p>
                    <p className="text-xs text-stone-500">{a.email}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs font-bold">{a.referralCode ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-stone-500">
                    {a.referralCode ? `${getBaseUrl()}/r/${a.referralCode}` : "—"}
                  </td>
                  <td className="px-4 py-3">{a.clicks ?? "—"}</td>
                  <td className="px-4 py-3">{a.sales ?? "—"}</td>
                  <td className="px-4 py-3">{a.commissions?.pending !== undefined ? formatMoney(a.commissions.pending) : "—"}</td>
                  <td className="px-4 py-3">{a.commissions?.retained !== undefined ? formatMoney(a.commissions.retained) : "—"}</td>
                  <td className="px-4 py-3">{a.commissions?.available !== undefined ? formatMoney(a.commissions.available) : "—"}</td>
                  <td className="px-4 py-3">{a.commissions?.paid !== undefined ? formatMoney(a.commissions.paid) : "—"}</td>
                  <td className="px-4 py-3">{availableOf(a) !== undefined ? formatMoney(availableOf(a) as number) : "—"}</td>
                  <td className="px-4 py-3">{a.riskStatus ?? "NORMAL"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
