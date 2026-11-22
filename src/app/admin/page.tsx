export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import type { AdminStats } from "@/components/types";
import { formatMoney } from "@/components/format";


function statValue(v: unknown): string {
  if (typeof v === "number") return v.toLocaleString("es-DO");
  if (typeof v === "string") return v;
  return "—";
}

function moneyValue(v: unknown): string | null {
  if (typeof v === "number") return formatMoney(v);
  return null;
}

/** GET /api/admin/stats — ventas, pendientes, reembolsos, contracargos, comisiones, ganancia, % vendido, ritmo, conversión, alertas. */
export default async function AdminDashboardPage() {
  let stats: AdminStats | null = null;
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/stats");
    if (!res.ok) loadError = true;
    else stats = (await res.json()) as AdminStats;
  } catch {
    loadError = true;
  }

  const revenue = moneyValue(stats?.totalRevenue);
  const profit = moneyValue(stats?.profit);
  const cards: Array<[string, string, string]> = [
    ["Ventas (boletos)", statValue(stats?.totalSales ?? stats?.totalTicketsSold), "/admin/ventas"],
    ["Ingresos confirmados", revenue ?? statValue(stats?.totalRevenue), "/admin/reportes"],
    ["Ganancia", profit ?? "—", "/admin/reportes"],
    ["Órdenes", statValue(stats?.totalOrders), "/admin/ventas"],
    ["Órdenes pendientes", statValue(stats?.pendingOrders), "/admin/ventas?status=PENDIENTE"],
    ["Reembolsos", statValue(stats?.refunds), "/admin/ventas?status=REEMBOLSADO"],
    ["Contracargos", statValue(stats?.chargebacks), "/admin/ventas?status=DISPUTADO"],
    ["Rifas", statValue(stats?.totalRaffles), "/admin/rifas"],
    ["Afiliados", statValue(stats?.totalAffiliates), "/admin/afiliados"],
    ["% vendido (global)", typeof stats?.percentSold === "number" ? `${Math.round(stats.percentSold)}%` : "—", "/admin/rifas"],
    ["Conversión", typeof stats?.conversionRate === "number" ? `${(stats.conversionRate * 100).toFixed(1)}%` : statValue(stats?.conversionRate), "/admin/reportes"],
    ["Ritmo de ventas", statValue(stats?.salesRate), "/admin/reportes"],
  ];

  const alerts = Array.isArray(stats?.alerts) ? stats.alerts : [];

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Dashboard</h2>
      <p className="mt-1 text-sm text-stone-600">Resumen financiero y comercial de Prende Rifas.</p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar las estadísticas en este momento. Inténtalo de nuevo en unos minutos.
        </div>
      )}

      {alerts.length > 0 && (
        <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-5" role="alert">
          <h3 className="font-bold text-rose-900">Alertas</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-800">
            {alerts.map((a, i) => (
              <li key={i}>{typeof a === "string" ? a : JSON.stringify(a)}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(([label, value, href]) => (
          <Link key={label} href={href} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm transition hover:shadow-md">
            <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</p>
            <p className="mt-1 text-2xl font-black text-stone-900">{value}</p>
          </Link>
        ))}
      </div>

      {stats && (
        <details className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 text-sm shadow-sm">
          <summary className="cursor-pointer font-semibold text-stone-800">Ver datos completos de la API</summary>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-stone-50 p-3 font-mono text-xs text-stone-700">
            {JSON.stringify(stats, null, 2)}
          </pre>
        </details>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Link href="/admin/rifas/nueva" className="rounded-xl bg-orange-600 px-4 py-3 text-center text-sm font-bold text-white hover:bg-orange-700">
          + Crear rifa
        </Link>
        <Link href="/admin/ventas?status=PENDIENTE" className="rounded-xl border border-stone-300 bg-white px-4 py-3 text-center text-sm font-semibold text-stone-700 hover:bg-stone-100">
          Revisar pagos pendientes
        </Link>
        <Link href="/admin/sorteos" className="rounded-xl border border-stone-300 bg-white px-4 py-3 text-center text-sm font-semibold text-stone-700 hover:bg-stone-100">
          Ejecutar sorteos
        </Link>
      </div>
    </div>
  );
}
