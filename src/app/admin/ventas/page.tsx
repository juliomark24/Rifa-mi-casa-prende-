export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { Order } from "@/components/types";
import { formatDate, formatMoney, statusLabel } from "@/components/format";
import { OrderActions } from "@/components/AdminActions";


/** GET /api/admin/orders?status= */
export default async function AdminOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const filter = status ?? "";
  let orders: Order[] = [];
  let loadError = false;
  try {
    const qs = filter ? `?status=${encodeURIComponent(filter)}` : "";
    const res = await serverFetch(`/api/admin/orders${qs}`);
    if (!res.ok) loadError = true;
    else orders = asArray<Order>(await res.json(), "orders");
  } catch {
    loadError = true;
  }

  const filters: Array<[string, string]> = [
    ["", "Todas"],
    ["PENDIENTE", "Pendientes"],
    ["CONFIRMADO", "Confirmadas"],
    ["FALLIDO", "Fallidas"],
    ["EXPIRADO", "Expiradas"],
    ["REEMBOLSADO", "Reembolsadas"],
    ["DISPUTADO", "En disputa"],
  ];

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Ventas (órdenes)</h2>
      <p className="mt-1 text-sm text-stone-600">Confirma las transferencias recibidas o cancela órdenes pendientes.</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {filters.map(([value, label]) => (
          <Link
            key={value}
            href={value ? `/admin/ventas?status=${value}` : "/admin/ventas"}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${filter === value ? "bg-orange-600 text-white" : "bg-white text-stone-700 ring-1 ring-stone-300"}`}
          >
            {label}
          </Link>
        ))}
      </div>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar las órdenes en este momento.
        </div>
      )}

      {!loadError && orders.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">No hay órdenes con este filtro.</p>
      )}

      {orders.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-200 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3">Orden</th>
                <th className="px-4 py-3">Comprador</th>
                <th className="px-4 py-3">Rifa</th>
                <th className="px-4 py-3">Método</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-stone-100">
                  <td className="px-4 py-3 font-mono text-xs font-bold">{o.code}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{o.buyerName}</p>
                    <p className="text-xs text-stone-500">{o.buyerEmail}</p>
                  </td>
                  <td className="px-4 py-3">{o.raffle?.title ?? o.raffleId}</td>
                  <td className="px-4 py-3 font-mono text-xs">{o.paymentMethodCode}</td>
                  <td className="px-4 py-3 font-semibold">{formatMoney(o.totalAmount, o.currency ?? o.raffle?.currency ?? "DOP")}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${o.status === "CONFIRMADO" ? "bg-emerald-100 text-emerald-800" : o.status === "REEMBOLSADO" || o.status === "FALLIDO" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"}`}>
                      {statusLabel(o.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">{formatDate(o.createdAt)}</td>
                  <td className="px-4 py-3">
                    <OrderActions id={o.id} status={o.status} />
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
