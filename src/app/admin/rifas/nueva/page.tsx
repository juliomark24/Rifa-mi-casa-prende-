export const instant = false;

import RaffleForm from "@/components/RaffleForm";

export default function NewRafflePage() {
  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Nueva rifa</h2>
      <p className="mt-1 text-sm text-stone-600">Crea una rifa en borrador o actívala directamente.</p>
      <div className="mt-5">
        <RaffleForm />
      </div>
    </div>
  );
}
