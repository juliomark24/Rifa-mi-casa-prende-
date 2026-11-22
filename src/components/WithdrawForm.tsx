"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "./format";
import { clientApi } from "./clientApi";

/** POST /api/affiliates/withdraw {amount} ≥ mínimo configurable (def. RD$500). */
export default function WithdrawForm({ balance, currency }: { balance: number; currency: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("Escribe un monto mayor que 0.");
      return;
    }
    if (value > balance) {
      setError(`El monto no puede superar tu saldo disponible (${formatMoney(balance, currency)}).`);
      return;
    }
    setLoading(true);
    try {
      const res = await clientApi("/api/affiliates/withdraw", {
        method: "POST",
        body: JSON.stringify({ amount: value }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSuccess(`Solicitud de retiro por ${formatMoney(value, currency)} enviada. Un administrador la revisará.`);
      setAmount("");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-bold text-stone-900">Solicitar retiro</h2>
      <p className="mt-1 text-sm text-stone-600">
        Saldo disponible: <strong>{formatMoney(balance, currency)}</strong>. El retiro mínimo es RD$500 o su
        equivalente. El retiro lo paga un administrador tras revisarlo.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="number"
          min={1}
          max={balance}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Monto"
          className="w-40 rounded-lg border border-stone-300 px-3 py-2 text-sm"
          aria-label="Monto a retirar"
        />
        <button type="submit" disabled={loading || balance <= 0} className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
          {loading ? "Enviando…" : "Solicitar retiro"}
        </button>
      </div>
      {error && (
        <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800" role="alert">{error}</p>
      )}
      {success && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800" role="status">{success}</p>
      )}
    </form>
  );
}
