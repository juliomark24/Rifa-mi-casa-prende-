export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { Raffle } from "@/components/types";
import RaffleCard from "@/components/RaffleCard";


async function fetchRaffles(status: string): Promise<Raffle[]> {
  try {
    const res = await serverFetch(`/api/raffles?status=${status}`);
    if (!res.ok) return [];
    return asArray<Raffle>(await res.json(), "raffles");
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const [active, upcoming, drawn] = await Promise.all([
    fetchRaffles("ACTIVA"),
    fetchRaffles("PROGRAMADA"),
    fetchRaffles("GANADOR_PUBLICADO"),
  ]);

  const featured = [...active].sort((a, b) => (b.percentSold ?? 0) - (a.percentSold ?? 0))[0];
  const restActive = featured ? active.filter((r) => r.id !== featured.id) : active;
  const apiDown = active.length === 0 && upcoming.length === 0 && drawn.length === 0;

  return (
    <div>
      {/* Hero con gradiente CSS (sin imágenes externas) */}
      <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-amber-500 via-orange-600 to-rose-600 px-6 py-12 text-white shadow-lg sm:px-10">
        <p className="text-xs font-bold uppercase tracking-widest text-amber-100">Rifas digitales · Sorteo transparente</p>
        <h1 className="mt-2 max-w-2xl text-3xl font-black leading-tight sm:text-5xl">
          Tu boleto puede ser el ganador. Compra, verifica y gana.
        </h1>
        <p className="mt-3 max-w-xl text-base text-amber-50">
          Premios reales, sorteo público con semilla y hash verificables, y pago seguro por tarjeta o transferencia.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="#rifa-activa" className="rounded-lg bg-white px-5 py-3 text-sm font-bold text-orange-700 hover:bg-amber-50">
            Ver rifa activa
          </a>
          <Link href="/verificar" className="rounded-lg border border-white/60 px-5 py-3 text-sm font-bold text-white hover:bg-white/10">
            Verificar mi boleto
          </Link>
          <Link href="/ganadores" className="rounded-lg border border-white/60 px-5 py-3 text-sm font-bold text-white hover:bg-white/10">
            Ganadores
          </Link>
          <Link href="/registro-afiliado" className="rounded-lg border border-white/60 px-5 py-3 text-sm font-bold text-white hover:bg-white/10">
            Gana 10% como afiliado
          </Link>
        </div>
      </section>

      {apiDown && (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar las rifas en este momento. Inténtalo de nuevo en unos minutos.
        </div>
      )}

      {/* Rifa activa destacada */}
      <section id="rifa-activa" className="mt-10">
        <h2 className="text-2xl font-black text-stone-900">Rifa activa</h2>
        {featured ? (
          <div className="mt-4 grid gap-5 md:grid-cols-2">
            <RaffleCard raffle={featured} featured />
          </div>
        ) : (
          !apiDown && (
            <p className="mt-4 rounded-xl border border-stone-200 bg-white p-5 text-sm text-stone-600">
              No hay ninguna rifa activa en este momento. Vuelve pronto o revisa las próximas rifas.
            </p>
          )
        )}
        {restActive.length > 0 && (
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {restActive.map((r) => (
              <RaffleCard key={r.id} raffle={r} />
            ))}
          </div>
        )}
      </section>

      {/* Próximas */}
      <section className="mt-12">
        <h2 className="text-2xl font-black text-stone-900">Próximas rifas</h2>
        {upcoming.length > 0 ? (
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((r) => (
              <RaffleCard key={r.id} raffle={r} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-stone-500">No hay rifas próximas anunciadas.</p>
        )}
      </section>

      {/* Terminadas con ganador */}
      <section className="mt-12">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-2xl font-black text-stone-900">Rifas terminadas</h2>
          <Link href="/ganadores" className="text-sm font-semibold text-orange-600 hover:underline">
            Ver todos los ganadores →
          </Link>
        </div>
        {drawn.length > 0 ? (
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {drawn.map((r) => (
              <RaffleCard key={r.id} raffle={r} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-stone-500">Aún no hay rifas sorteadas. Los ganadores aparecerán aquí con su boleto.</p>
        )}
      </section>
    </div>
  );
}
