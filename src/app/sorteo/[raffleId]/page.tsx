export const instant = false;

import Link from "next/link";
import { notFound } from "next/navigation";
import { serverFetch } from "@/components/api";
import type { Draw, Raffle } from "@/components/types";
import { formatDate } from "@/components/format";

/**
 * GET /api/draws/[raffleId] — resultado público verificable (commit-reveal):
 * commitment, seed revelada, hashElegibles, totalElegibles,
 * winnerTicketNumber, algorithm, executedAt, drawId.
 * Antes del sorteo no hay resultado: se muestra el estado y la fecha.
 */
export default async function DrawResultPage({ params }: { params: Promise<{ raffleId: string }> }) {
  const { raffleId } = await params;

  let raffle: Raffle | null = null;
  let draw: Draw | null = null;
  let loadError = false;
  try {
    const [raffleRes, drawRes] = await Promise.all([
      serverFetch(`/api/raffles/${raffleId}`),
      serverFetch(`/api/draws/${raffleId}`),
    ]);
    if (raffleRes.status === 404) notFound();
    if (raffleRes.ok) raffle = (await raffleRes.json()) as Raffle;
    if (drawRes.ok) draw = (await drawRes.json()) as Draw;
    else if (drawRes.status !== 404) loadError = true;
  } catch {
    loadError = true;
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800" role="alert">
        No pudimos cargar el resultado del sorteo en este momento. Inténtalo de nuevo en unos minutos.
      </div>
    );
  }

  const winnerNumber = draw?.winnerTicketNumber ?? draw?.winningTicket?.number ?? null;
  const winnerCode = draw?.winnerTicketCode ?? draw?.winningTicket?.code ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-black text-stone-900">Resultado del sorteo</h1>
      {raffle && (
        <p className="mt-1 text-sm text-stone-600">
          {raffle.title} · Premio: <strong>{raffle.prize}</strong> · Sorteo: {formatDate(raffle.drawAt)}
        </p>
      )}

      {!draw ? (
        <div className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
          <p className="mt-3 font-bold text-stone-900">El sorteo aún no se ha realizado</p>
          <p className="mt-1 text-sm text-stone-600">
            Cuando se ejecute, el boleto ganador, la semilla revelada, el compromiso previo y el hash de elegibles
            aparecerán aquí para que cualquiera pueda verificarlos.
          </p>
          {raffle && (
            <Link href={`/rifas/${raffle.id}`} className="mt-4 inline-block rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-700">
              Ver la rifa
            </Link>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="rounded-2xl bg-gradient-to-br from-amber-500 via-orange-600 to-rose-600 p-6 text-center text-white shadow-lg">
            <p className="text-xs font-bold uppercase tracking-widest text-amber-100">Boleto ganador</p>
            <p className="mt-2 font-mono text-4xl font-black">#{winnerNumber ?? "—"}</p>
            {winnerCode && <p className="mt-1 font-mono text-lg">{winnerCode}</p>}
            <p className="mt-2 text-sm text-amber-50">
              De {draw.totalElegibles} boletos elegibles · Sorteo ejecutado el {formatDate(draw.executedAt)}
            </p>
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Verificación pública</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="font-semibold text-stone-700">ID del sorteo</dt>
                <dd className="break-all font-mono text-xs text-stone-600">{draw.drawId}</dd>
              </div>
              <div>
                <dt className="font-semibold text-stone-700">Compromiso publicado antes del sorteo</dt>
                <dd className="break-all font-mono text-xs text-stone-600">{draw.commitment}</dd>
              </div>
              <div>
                <dt className="font-semibold text-stone-700">Semilla revelada tras el sorteo</dt>
                <dd className="break-all font-mono text-xs text-stone-600">{draw.seed ?? "Aún no revelada"}</dd>
              </div>
              <div>
                <dt className="font-semibold text-stone-700">Hash SHA256 de la lista de elegibles</dt>
                <dd className="break-all font-mono text-xs text-stone-600">{draw.hashElegibles}</dd>
              </div>
              <div>
                <dt className="font-semibold text-stone-700">Total de boletos elegibles</dt>
                <dd className="text-stone-700">{draw.totalElegibles}</dd>
              </div>
              <div>
                <dt className="font-semibold text-stone-700">Algoritmo</dt>
                <dd className="break-all text-stone-700">{draw.algorithm}</dd>
              </div>
              <div>
                <dt className="font-semibold text-stone-700">Fecha de ejecución</dt>
                <dd className="text-stone-700">{formatDate(draw.executedAt)}</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-stone-500">
              Antes del sorteo se publicó el compromiso (SHA256 de la semilla secreta + el hash de elegibles), así
              que ni el administrador podía cambiar la semilla o la lista después de ver el resultado. Con la semilla
              revelada, el hash de elegibles y el algoritmo publicado, cualquiera puede reproducir el resultado.
            </p>
          </div>

          {raffle && (
            <Link href={`/rifas/${raffle.id}`} className="inline-block rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100">
              ← Volver a la rifa
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
