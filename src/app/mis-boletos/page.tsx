export const instant = false;

import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { Order, Ticket } from "@/components/types";
import { formatDate, formatMoney, statusLabel } from "@/components/format";
import TicketQr from "@/components/TicketQr";


/** GET /api/orders/mine (auth). Cada orden trae sus tickets. */
export default async function MisBoletosPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  let orders: Order[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/orders/mine");
    if (res.status === 401) redirect("/login");
    if (!res.ok) loadError = true;
    else orders = asArray<Order>(await res.json(), "orders");
  } catch {
    loadError = true;
  }

  const tickets: Array<Ticket & { order?: Order }> = [];
  for (const order of orders) {
    for (const t of order.tickets ?? []) tickets.push({ ...t, order, raffle: t.raffle ?? order.raffle ?? null });
  }

  return (
    <div>
      <h1 className="text-2xl font-black text-stone-900">Mis boletos</h1>
      <p className="mt-1 text-sm text-stone-600">
        Hola, {session.name}. Aquí están todos tus boletos. Guarda el código QR: es tu comprobante para reclamar el premio.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar tus boletos en este momento. Inténtalo de nuevo en unos minutos.
        </div>
      )}

      {!loadError && tickets.length === 0 && (
        <div className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-center">
          <p className="text-stone-700">Aún no tienes boletos.</p>
          <Link href="/" className="mt-3 inline-block rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-700">
            Ver rifas activas
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tickets.map((t) => (
          <article key={t.id} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <TicketQr code={t.code} size={120} />
              <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${t.status === "VENDIDO" ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>
                {statusLabel(t.status)}
              </span>
            </div>
            <p className="mt-4 font-mono text-lg font-bold text-stone-900">{t.code}</p>
            <p className="text-sm text-stone-700">
              Boleto <strong>#{t.number}</strong>
              {t.raffle ? ` · ${t.raffle.title}` : ""}
            </p>
            {t.raffle && (
              <p className="text-sm text-stone-500">Premio: {t.raffle.prize} · Sorteo {formatDate(t.raffle.drawAt)}</p>
            )}
            {t.order && (
              <p className="mt-1 text-xs text-stone-500">
                Orden {t.order.code} · {formatMoney(t.order.totalAmount, t.raffle?.currency ?? "DOP")} · {statusLabel(t.order.status)}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/verificar" className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                Verificar
              </Link>
              {t.order && (
                <a
                  href={`/api/orders/${encodeURIComponent(t.order.code)}/receipt`}
                  className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100"
                >
                  Comprobante (PDF)
                </a>
              )}
              {t.raffle && (
                <Link href={`/sorteo/${t.raffle.id}`} className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                  Ver sorteo
                </Link>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
