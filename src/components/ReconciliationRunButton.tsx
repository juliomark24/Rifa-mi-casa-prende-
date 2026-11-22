"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "./clientApi";
import { newIdempotencyKey } from "./types";

/** Dispara la conciliación bajo demanda (POST /api/admin/reconciliation/run). */
export default function ReconciliationRunButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run() {
    if (!window.confirm("¿Ejecutar la conciliación ahora? Compara pedidos, pagos, boletos y ledger; las discrepancias abren casos de revisión.")) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await clientApi<{ casesCreated?: number; casesAlreadyOpen?: number; period?: string }>(
        "/api/admin/reconciliation/run",
        { method: "POST", idempotencyKey: newIdempotencyKey() },
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const created = res.data?.casesCreated ?? 0;
      setDone(`Conciliación ejecutada (período ${res.data?.period ?? "—"}): ${created} caso(s) nuevo(s).`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50"
      >
        {busy ? "Conciliando…" : "Ejecutar conciliación ahora"}
      </button>
      {done && <span className="text-xs font-medium text-emerald-700">{done}</span>}
      {error && <span className="text-xs text-rose-700">{error}</span>}
    </span>
  );
}
