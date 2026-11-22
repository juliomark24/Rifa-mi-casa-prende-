export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { LedgerBalances, LedgerMovement } from "@/components/types";
import { formatDate, formatMoney } from "@/components/format";

/**
 * Libro contable (plan §2.3) — S9-int: la página no existía aunque el
 * backend expone GET /api/admin/ledger/balances, /movements y /export
 * desde S6. Los saldos se derivan del ledger + del estado de las
 * comisiones (nunca columnas editables). Dinero en enteros; VENTA
 * positivo; REEMBOLSO/CONTRACARGO/COMISION/RETIRO negativos.
 */
const LEDGER_TYPES = ["VENTA", "COMISION", "REEMBOLSO", "CONTRACARGO", "COSTO", "RETIRO", "RESERVA", "AJUSTE"] as const;

function balanceCard(label: string, value: number, currency: string, tone?: "good" | "bad") {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</p>
      <p
        className={`mt-1 text-xl font-black ${
          tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-stone-900"
        }`}
      >
        {formatMoney(value, currency)}
      </p>
    </div>
  );
}

export default async function AdminLedgerPage({
  searchParams,
}: {
  searchParams?: Promise<{ type?: string; currency?: string; page?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const type = sp.type ?? "";
  const currency = sp.currency ?? "";
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  let balances: LedgerBalances | null = null;
  let movements: LedgerMovement[] = [];
  let total = 0;
  let loadError = false;
  try {
    const [bRes, mRes] = await Promise.all([
      serverFetch(`/api/admin/ledger/balances${currency ? `?currency=${encodeURIComponent(currency)}` : ""}`),
      serverFetch(
        `/api/admin/ledger/movements?limit=50&page=${page}${type ? `&type=${encodeURIComponent(type)}` : ""}${currency ? `&currency=${encodeURIComponent(currency)}` : ""}`,
      ),
    ]);
    if (!bRes.ok || !mRes.ok) loadError = true;
    else {
      balances = (await bRes.json()) as LedgerBalances;
      const body = (await mRes.json()) as { data?: LedgerMovement[]; total?: number };
      movements = asArray<LedgerMovement>(body, "movements");
      total = body.total ?? movements.length;
    }
  } catch {
    loadError = true;
  }

  const cur = balances?.currency ?? currency ?? "DOP";
  const exportHref = `/api/admin/ledger/export${type || currency ? `?${new URLSearchParams({ ...(type ? { type } : {}), ...(currency ? { currency } : {}) }).toString()}` : ""}`;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black text-stone-900">Libro contable (ledger)</h2>
          <p className="mt-1 text-sm text-stone-600">
            Movimientos inmutables (append-only): ventas, comisiones, reembolsos, contracargos, costos, retiros y
            ajustes. Los errores se corrigen con asientos compensatorios, nunca borrando.{" "}
            {balances ? `${balances.movimientos} asientos en el rango.` : ""}
          </p>
        </div>
        <a
          href={exportHref}
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
        >
          Exportar CSV
        </a>
      </div>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar el ledger en este momento.
        </div>
      )}

      {balances && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {balanceCard("Ventas confirmadas", balances.ventas, cur, "good")}
          {balanceCard("Reembolsos", balances.reembolsos, cur, "bad")}
          {balanceCard("Contracargos", balances.contracargos, cur, "bad")}
          {balanceCard("Neto", balances.neto, cur)}
          {balanceCard("Comisiones (neto)", balances.comisionesNeto, cur)}
          {balanceCard("Comisiones comprometidas", balances.comisionesComprometidas, cur)}
          {balanceCard("Comisiones disponibles", balances.comisionesDisponibles, cur, "good")}
          {balanceCard("Comisiones pagadas", balances.comisionesPagadas, cur)}
          {balanceCard("Retiros pagados", balances.retiros, cur)}
          {balanceCard("En disputa (pedidos)", balances.enDisputaPedidos, cur, "bad")}
          {balanceCard("Costos", balances.costos, cur)}
          {balanceCard("Reservas", balances.reservas, cur)}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-1 text-xs">
        <Link
          href="/admin/ledger"
          className={`rounded-lg px-3 py-1.5 font-semibold ${!type ? "bg-orange-600 text-white" : "bg-white text-stone-700 hover:bg-stone-100"}`}
        >
          Todos
        </Link>
        {LEDGER_TYPES.map((t) => (
          <Link
            key={t}
            href={`/admin/ledger?type=${t}`}
            className={`rounded-lg px-3 py-1.5 font-semibold ${type === t ? "bg-orange-600 text-white" : "bg-white text-stone-700 hover:bg-stone-100"}`}
          >
            {t}
          </Link>
        ))}
      </div>

      {movements.length === 0 && !loadError && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
          No hay movimientos con este filtro.
        </p>
      )}

      {movements.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-175 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Monto</th>
                <th className="px-4 py-3">Referencia</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id} className="border-t border-stone-100">
                  <td className="px-4 py-3 text-xs text-stone-500">{formatDate(m.createdAt)}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-stone-100 px-2 py-1 text-xs font-bold text-stone-700">{m.type}</span>
                  </td>
                  <td className={`px-4 py-3 font-mono font-bold ${m.amount < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                    {formatMoney(m.amount, m.currency)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-stone-500">
                    {m.refType} · {m.refId.slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-stone-100 px-4 py-3 text-xs text-stone-500">
            Página {page} · {total} movimientos en total.
          </p>
        </div>
      )}
    </div>
  );
}
