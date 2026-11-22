export const instant = false;

import { notFound } from "next/navigation";
import { serverFetch } from "@/components/api";
import type { Raffle } from "@/components/types";
import RaffleForm from "@/components/RaffleForm";


export default async function EditRafflePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let raffle: Raffle | null = null;
  try {
    const res = await serverFetch(`/api/raffles/${id}`);
    if (res.status === 404) notFound();
    if (res.ok) raffle = (await res.json()) as Raffle;
  } catch {
    raffle = null;
  }

  if (!raffle) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800" role="alert">
        No pudimos cargar esta rifa para editarla. Inténtalo de nuevo en unos minutos.
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Editar rifa</h2>
      <p className="mt-1 text-sm text-stone-600">{raffle.title}</p>
      <div className="mt-5">
        <RaffleForm raffle={raffle} />
      </div>
    </div>
  );
}
