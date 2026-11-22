export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { Raffle } from "@/components/types";
import { formatDate, percentSoldOf, statusLabel } from "@/components/format";
import { DrawActions } from "@/components/AdminActions";


/**
 * Sorteos (commit-reveal, contrato v2.2):
 *  1. Publicar compromiso: congela elegibles + publica el commitment.
 *  2. Ejecutar sorteo: revela la semilla + ganador (bloqueado si hay pagos
 *     o reservas sin resolver, o si ya se sorteó).
 * Rifas sorteables: CERRADA o EN_SORTEO con al menos 1 boleto vendido.
 */
export default async function AdminDrawsPage() {
  let raffles: Raffle[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/raffles?limit=100");
    if (!res.ok) loadError = true;
    else raffles = asArray<Raffle>(await res.json(), "raffles");
  } catch {
    loadError = true;
  }

  const sortable = raffles.filter((r) => {
    const sold = r.soldCount ?? r.soldNumbers?.length ?? 0;
    if (sold < 1) return false;
    return r.status === "CERRADA" || r.status === "EN_SORTEO";
  });
  const drawn = raffles.filter((r) => r.status === "GANADOR_PUBLICADO" || r.status === "FINALIZADA");

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Sorteos</h2>
      <p className="mt-1 text-sm text-stone-600">
        Solo se puede sortear una rifa cerrada con al menos 1 boleto vendido. El sorteo es commit-reveal: primero se
        publica el compromiso (se congelan los elegibles) y después se ejecuta (se revela la semilla y el ganador).
        Una rifa solo se sortea una vez.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar las rifas en este momento.
        </div>
      )}

      {!loadError && sortable.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
          No hay rifas listas para sortear en este momento.
        </p>
      )}

      {sortable.length > 0 && (
        <div className="mt-5 grid gap-4">
          {sortable.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <div>
                <p className="font-bold text-stone-900">{r.title}</p>
                <p className="text-sm text-stone-600">
                  {r.prize} · {percentSoldOf(r)}% vendido ({r.soldCount ?? r.soldNumbers?.length ?? 0}/{r.totalTickets}) ·
                  Sorteo: {formatDate(r.drawAt)} · {statusLabel(r.status)}
                </p>
              </div>
              <DrawActions raffleId={r.id} committed={r.status === "EN_SORTEO"} />
            </div>
          ))}
        </div>
      )}

      <section className="mt-10">
        <h3 className="text-lg font-bold text-stone-900">Rifas ya sorteadas</h3>
        {drawn.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">Aún no hay rifas sorteadas.</p>
        ) : (
          <div className="mt-3 grid gap-3">
            {drawn.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                <div>
                  <p className="font-semibold text-stone-900">{r.title}</p>
                  <p className="text-sm text-stone-600">
                    {r.prize} · Sorteo: {formatDate(r.drawAt)}
                  </p>
                </div>
                <span className="flex gap-2">
                  <Link href={`/sorteo/${r.id}`} className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                    Ver resultado público
                  </Link>
                  <Link href="/admin/ganadores" className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                    Gestionar ganador
                  </Link>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
