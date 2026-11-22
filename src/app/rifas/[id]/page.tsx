export const instant = false;

import { notFound } from "next/navigation";
import { serverFetch } from "@/components/api";
import type { Raffle } from "@/components/types";
import { formatDate, formatMoney, percentSoldOf, statusLabel } from "@/components/format";
import Countdown from "@/components/Countdown";
import PurchaseForm from "@/components/PurchaseForm";


export default async function RaffleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let raffle: Raffle | null = null;
  let loadError = false;
  try {
    const res = await serverFetch(`/api/raffles/${id}`);
    if (res.status === 404) notFound();
    if (!res.ok) loadError = true;
    else raffle = (await res.json()) as Raffle;
  } catch {
    loadError = true;
  }

  if (loadError || !raffle) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800" role="alert">
        No pudimos cargar esta rifa en este momento. Inténtalo de nuevo en unos minutos.
      </div>
    );
  }

  const percent = percentSoldOf(raffle);
  const sold = raffle.soldCount ?? raffle.soldNumbers?.length ?? 0;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="lg:col-span-3">
        {raffle.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={raffle.imageUrl} alt={raffle.prize} className="h-72 w-full rounded-2xl object-cover" />
        ) : (
          <div className="flex h-72 w-full flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 via-orange-500 to-rose-600 px-6 text-center">
            <span className="text-xs font-bold uppercase tracking-widest text-amber-100">Premio</span>
            <span className="mt-2 text-3xl font-black leading-tight text-white sm:text-4xl">{raffle.prize}</span>
          </div>
        )}

        <div className="mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h1 className="text-2xl font-black text-stone-900">{raffle.title}</h1>
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">{statusLabel(raffle.status)}</span>
          </div>
          <p className="mt-3 whitespace-pre-line text-stone-700">{raffle.description}</p>

          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-lg bg-stone-50 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-stone-500">Precio por boleto</dt>
              <dd className="text-lg font-bold text-stone-900">{formatMoney(raffle.ticketPrice, raffle.currency)}</dd>
            </div>
            <div className="rounded-lg bg-stone-50 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-stone-500">País / Moneda</dt>
              <dd className="text-lg font-bold text-stone-900">{raffle.country} · {raffle.currency}</dd>
            </div>
            <div className="rounded-lg bg-stone-50 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-stone-500">Fecha del sorteo</dt>
              <dd className="font-semibold text-stone-900">{formatDate(raffle.drawAt)}</dd>
            </div>
            <div className="rounded-lg bg-stone-50 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-stone-500">Boletos</dt>
              <dd className="font-semibold text-stone-900">{sold} vendidos de {raffle.totalTickets}</dd>
            </div>
          </dl>

          {raffle.status !== "GANADOR_PUBLICADO" && raffle.status !== "FINALIZADA" && (
            <div className="mt-5">
              <div className="mb-1.5 flex justify-between text-xs font-medium text-stone-600">
                <span>{percent}% vendido</span>
                <span>{raffle.totalTickets - sold} disponibles</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-stone-200">
                <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-600" style={{ width: `${Math.min(100, percent)}%` }} />
              </div>
              <div className="mt-3">
                <Countdown target={raffle.drawAt} />
              </div>
            </div>
          )}

          {raffle.rules && (
            <div className="mt-5 border-t border-stone-200 pt-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Reglas de la rifa</h2>
              <p className="mt-2 whitespace-pre-line text-sm text-stone-700">{raffle.rules}</p>
            </div>
          )}

          {raffle.licenseNumber && (
            <p className="mt-4 text-xs text-stone-500">
              Licencia / registro: <span className="font-mono font-semibold">{raffle.licenseNumber}</span>
              {raffle.termsVersionId ? ` · Bases versión ${raffle.termsVersionId}` : ""}
            </p>
          )}

          {(raffle.status === "GANADOR_PUBLICADO" || raffle.status === "FINALIZADA" || raffle.status === "EN_SORTEO") && (
            <div className="mt-5">
              <a
                href={`/sorteo/${raffle.id}`}
                className="inline-block rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-700"
              >
                Ver resultado del sorteo →
              </a>
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-2">
        <PurchaseForm raffle={raffle} />
      </div>
    </div>
  );
}
