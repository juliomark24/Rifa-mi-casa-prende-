export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { ReconciliationCase } from "@/components/types";
import { formatDate, formatMoney } from "@/components/format";
import ReconciliationRunButton from "@/components/ReconciliationRunButton";

/**
 * Conciliación (plan §2.13, P21) — S9-int: la página no existía aunque el
 * backend expone GET /api/admin/reconciliation (casos + conteos) y POST
 * /api/admin/reconciliation/run (bajo demanda) desde S5/S6. Toda
 * discrepancia genera un caso ABIERTO con su detalle; nunca se corrigen
 * registros en silencio. Un pedido reembolsado o en contracargo NO genera
 * caso `venta-sin-confirmacion` (su VENTA es historia legítima).
 */
function caseDetail(c: ReconciliationCase): string {
  const d = c.detail ?? {};
  const kind = typeof d.kind === "string" ? d.kind : "discrepancia";
  const orderCode = typeof d.orderCode === "string" ? ` · pedido ${d.orderCode}` : "";
  const reason = typeof d.reason === "string" ? ` — ${d.reason}` : "";
  return `${kind}${orderCode}${reason}`;
}

export default async function AdminReconciliationPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string; provider?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const query = new URLSearchParams({ limit: "100" });
  if (sp.status) query.set("status", sp.status);
  if (sp.provider) query.set("provider", sp.provider);

  let cases: ReconciliationCase[] = [];
  let open = 0;
  let resolved = 0;
  let total = 0;
  let loadError = false;
  try {
    const res = await serverFetch(`/api/admin/reconciliation?${query.toString()}`);
    if (!res.ok) loadError = true;
    else {
      const body = (await res.json()) as { data?: ReconciliationCase[]; open?: number; resolved?: number; total?: number };
      cases = asArray<ReconciliationCase>(body, "cases");
      open = body.open ?? 0;
      resolved = body.resolved ?? 0;
      total = body.total ?? cases.length;
    }
  } catch {
    loadError = true;
  }

  const status = sp.status ?? "";
  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Conciliación</h2>
      <p className="mt-1 text-sm text-stone-600">
        Comparación diaria de pedidos, pagos, boletos y ledger contra los reportes de los proveedores. Cada
        discrepancia abre un caso con su detalle hasta resolverse. Casos abiertos: <strong>{open}</strong> ·
        resueltos: <strong>{resolved}</strong> · total: <strong>{total}</strong>.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ReconciliationRunButton />
        <span className="flex gap-1 text-xs">
          {[
            ["", "Todos"],
            ["ABIERTO", "Abiertos"],
            ["EN_REVISION", "En revisión"],
            ["RESUELTO", "Resueltos"],
          ].map(([value, label]) => (
            <Link
              key={value}
              href={value ? `/admin/conciliacion?status=${value}` : "/admin/conciliacion"}
              className={`rounded-lg px-3 py-1.5 font-semibold ${status === value ? "bg-orange-600 text-white" : "bg-white text-stone-700 hover:bg-stone-100"}`}
            >
              {label}
            </Link>
          ))}
        </span>
      </div>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los casos de conciliación en este momento.
        </div>
      )}

      {!loadError && cases.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
          No hay casos de conciliación con este filtro. Cuando la conciliación encuentre una discrepancia, aparecerá
          aquí para revisión humana.
        </p>
      )}

      {cases.length > 0 && (
        <div className="mt-5 space-y-4">
          {cases.map((c) => (
            <article key={c.id} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-bold text-stone-900">{caseDetail(c)}</p>
                  <p className="mt-1 text-sm text-stone-600">
                    Proveedor: <span className="font-mono text-xs">{c.provider}</span>
                    {c.period ? ` · Período: ${c.period}` : ""}
                    {c.amount !== null && c.amount !== undefined
                      ? ` · Monto: ${formatMoney(c.amount, c.currency ?? "DOP")}`
                      : ""}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    Detectado: {formatDate(c.createdAt)}
                    {c.resolvedAt ? ` · Resuelto: ${formatDate(c.resolvedAt)}${c.resolvedBy ? ` por ${c.resolvedBy.name}` : ""}` : ""}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    c.status === "ABIERTO"
                      ? "bg-rose-100 text-rose-800"
                      : c.status === "EN_REVISION"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {c.status}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
