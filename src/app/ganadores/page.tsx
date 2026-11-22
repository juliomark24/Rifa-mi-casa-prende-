export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { PublicWinner } from "@/components/types";
import { formatDate } from "@/components/format";

/** GET /api/winners — ganadores publicados (sin datos personales salvo autorización). */
export default async function WinnersPage() {
  let winners: PublicWinner[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/winners");
    if (!res.ok) loadError = true;
    else winners = asArray<PublicWinner>(await res.json(), "winners");
  } catch {
    loadError = true;
  }

  return (
    <div>
      <h1 className="text-2xl font-black text-stone-900">Ganadores</h1>
      <p className="mt-1 text-sm text-stone-600">
        Todos los ganadores publicados, con su número de boleto y el resultado verificable del sorteo.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los ganadores en este momento. Inténtalo de nuevo en unos minutos.
        </div>
      )}

      {!loadError && winners.length === 0 && (
        <div className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
          <p className="text-stone-700">Aún no hay ganadores publicados.</p>
          <Link href="/" className="mt-3 inline-block rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-700">
            Ver rifas activas
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {winners.map((w, i) => (
          <article key={w.drawId ?? `${w.raffleId}-${i}`} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{w.raffleTitle ?? "Rifa"}</p>
            {w.prize && <p className="mt-1 font-bold text-stone-900">{w.prize}</p>}
            <p className="mt-3 text-center font-mono text-3xl font-black text-orange-600">#{w.winnerTicketNumber}</p>
            {w.winnerTicketCode && <p className="text-center font-mono text-sm text-stone-600">{w.winnerTicketCode}</p>}
            {w.winnerName && <p className="mt-1 text-center text-sm text-stone-700">Ganador: {w.winnerName}</p>}
            <p className="mt-3 text-center text-xs text-stone-500">
              Sorteo: {formatDate(w.executedAt ?? w.drawAt)}
            </p>
            <div className="mt-4 text-center">
              <Link href={`/sorteo/${w.raffleId}`} className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                Ver verificación del sorteo →
              </Link>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
