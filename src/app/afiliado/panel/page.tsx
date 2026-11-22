export const instant = false;

import { redirect } from "next/navigation";
import { getBaseUrl, getSession, serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { AffiliateSale, AffiliateStats } from "@/components/types";
import { formatDate, formatMoney } from "@/components/format";
import WithdrawForm from "@/components/WithdrawForm";
import CopyLinkButton from "@/components/CopyLinkButton";


export default async function AffiliatePanelPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "AFILIADO") redirect("/");

  let stats: AffiliateStats | null = null;
  let sales: AffiliateSale[] = [];
  let loadError = false;
  try {
    const [statsRes, salesRes] = await Promise.all([
      serverFetch("/api/affiliates/me"),
      serverFetch("/api/affiliates/me/sales"),
    ]);
    if (statsRes.status === 401) redirect("/login");
    if (statsRes.ok) stats = (await statsRes.json()) as AffiliateStats;
    else loadError = true;
    if (salesRes.ok) sales = asArray<AffiliateSale>(await salesRes.json(), "sales");
  } catch {
    loadError = true;
  }

  const referralLink =
    stats?.referralLink ??
    (stats?.referralCode ? `${getBaseUrl()}/r/${stats.referralCode}` : session.referralCode ? `${getBaseUrl()}/r/${session.referralCode}` : "");
  const currency = stats?.currency ?? "DOP";

  return (
    <div>
      <h1 className="text-2xl font-black text-stone-900">Panel de afiliado</h1>
      <p className="mt-1 text-sm text-stone-600">Hola, {session.name}. Comparte tu link y gana 10% por cada boleto vendido con tu referido.</p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar tus estadísticas en este momento. Inténtalo de nuevo en unos minutos.
        </div>
      )}

      {referralLink && (
        <div className="mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Tu link de referido</h2>
          <div className="mt-2">
            <CopyLinkButton link={referralLink} />
          </div>
          <p className="mt-2 text-xs text-stone-500">Cada clic en tu link queda registrado. La venta se te atribuye si el comprador usa tu link o tu código.</p>
        </div>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Clics", String(stats?.clicks ?? "—")],
          ["Ventas", String(stats?.sales ?? "—")],
          ["Comisión pendiente", formatMoney(stats?.commissionPending ?? 0, currency)],
          ["Comisión retenida", formatMoney(stats?.commissionRetained ?? 0, currency)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</p>
            <p className="mt-1 text-2xl font-black text-stone-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl border border-orange-200 bg-orange-50 p-5">
        <p className="text-xs font-bold uppercase tracking-wide text-orange-700">Saldo disponible para retiro</p>
        <p className="mt-1 text-3xl font-black text-orange-800">{formatMoney(stats?.balance ?? 0, currency)}</p>
        <p className="mt-1 text-sm text-orange-800">
          Disponible: {formatMoney(stats?.commissionAvailable ?? stats?.balance ?? 0, currency)} · Pagadas:{" "}
          {formatMoney(stats?.commissionPaid ?? 0, currency)} · La comisión se genera solo sobre ventas pagadas y
          queda retenida durante el período de riesgo.
        </p>
      </div>

      <WithdrawForm balance={stats?.balance ?? 0} currency={currency} />

      <section className="mt-8">
        <h2 className="text-lg font-bold text-stone-900">Mis ventas</h2>
        {sales.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">Aún no tienes ventas registradas. Comparte tu link para empezar a ganar.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
            <table className="w-full min-w-160 text-left text-sm">
              <thead className="bg-stone-50 text-xs uppercase text-stone-500">
                <tr>
                  <th className="px-4 py-3">Fecha</th>
                  <th className="px-4 py-3">Orden / Boleto</th>
                  <th className="px-4 py-3">Comisión</th>
                  <th className="px-4 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id} className="border-t border-stone-100">
                    <td className="px-4 py-3">{formatDate(s.createdAt)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{s.orderCode ?? s.orderId ?? s.ticketId ?? s.id}</td>
                    <td className="px-4 py-3 font-semibold">{formatMoney(s.commission ?? s.amount, currency)}</td>
                    <td className="px-4 py-3">{s.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
