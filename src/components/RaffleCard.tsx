import Link from "next/link";
import { formatDate, formatMoney, percentSoldOf, statusLabel } from "./format";
import type { Raffle } from "./types";
import Countdown from "./Countdown";

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-stone-200" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-600 transition-all" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

export default function RaffleCard({ raffle, featured = false }: { raffle: Raffle; featured?: boolean }) {
  const percent = percentSoldOf(raffle);
  const sold = raffle.soldCount ?? 0;
  const drawn = raffle.status === "GANADOR_PUBLICADO" || raffle.status === "FINALIZADA";

  return (
    <article className={`overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm transition hover:shadow-md ${featured ? "md:col-span-2" : ""}`}>
      {raffle.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={raffle.imageUrl} alt={raffle.prize} className="h-44 w-full object-cover" />
      ) : (
        <div className="flex h-44 w-full flex-col items-center justify-center bg-gradient-to-br from-amber-400 via-orange-500 to-rose-600 px-4 text-center">
          <span className="text-xs font-bold uppercase tracking-widest text-amber-100">Premio</span>
          <span className="mt-1 text-2xl font-black leading-tight text-white">{raffle.prize}</span>
        </div>
      )}
      <div className="p-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-bold leading-snug text-stone-900">{raffle.title}</h3>
          <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800">
            {statusLabel(raffle.status)}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-stone-600">{raffle.description}</p>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-700">
          <span>
            <strong className="text-lg text-stone-900">{formatMoney(raffle.ticketPrice, raffle.currency)}</strong>
            <span className="text-stone-500"> / boleto</span>
          </span>
          <span className="rounded-md bg-stone-100 px-2 py-0.5 text-xs font-semibold">
            {raffle.country} · {raffle.currency}
          </span>
          <span className="text-xs text-stone-500">Sorteo: {formatDate(raffle.drawAt)}</span>
        </div>

        {raffle.status !== "GANADOR_PUBLICADO" && raffle.status !== "FINALIZADA" && (
          <div className="mt-4">
            <div className="mb-1.5 flex justify-between text-xs font-medium text-stone-600">
              <span>{sold} de {raffle.totalTickets} boletos vendidos</span>
              <span className="font-bold text-orange-600">{percent}% vendido</span>
            </div>
            <ProgressBar percent={percent} />
            <div className="mt-3">
              <Countdown target={raffle.drawAt} compact />
            </div>
          </div>
        )}

        {drawn && (
          <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
            Sorteo realizado. Consulta el ganador y la verificación pública.
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <Link
            href={`/rifas/${raffle.id}`}
            className="flex-1 rounded-lg bg-orange-600 px-4 py-2.5 text-center text-sm font-bold text-white hover:bg-orange-700"
          >
            {raffle.status === "ACTIVA" ? "Comprar boletos" : "Ver detalles"}
          </Link>
          {drawn && (
            <Link
              href={`/sorteo/${raffle.id}`}
              className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-100"
            >
              Ver sorteo
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
