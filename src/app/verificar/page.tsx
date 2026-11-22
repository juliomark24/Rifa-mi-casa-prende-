"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDate, statusLabel } from "@/components/format";
import { clientApi } from "@/components/clientApi";
import type { VerifyResult } from "@/components/types";

/** GET /api/tickets/verify?code= → ticket + rifa + ganador (sí/no). */
export default function VerifyPage() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (!clean) {
      setError("Escribe el código de tu boleto (ej. PR-000123).");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await clientApi<VerifyResult>(`/api/tickets/verify?code=${encodeURIComponent(clean)}`);
      if (!res.ok) {
        setError(res.status === 404 ? `No encontramos un boleto con el código ${clean}.` : res.error);
        return;
      }
      setResult(res.data);
    } finally {
      setLoading(false);
    }
  }

  const ticket = result?.ticket;
  const raffle = result?.raffle;
  const isWinner = result?.isWinner ?? result?.winner ?? result?.won ?? false;

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-black text-stone-900">Verificar boleto</h1>
      <p className="mt-1 text-sm text-stone-600">
        Escribe el código de tu boleto (ej. <span className="font-mono font-semibold">PR-000123</span>) para ver su estado y saber si ganó.
      </p>

      <form onSubmit={handleSubmit} className="mt-5 flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="PR-000123"
          className="flex-1 rounded-lg border border-stone-300 px-4 py-2.5 font-mono uppercase"
          aria-label="Código del boleto"
        />
        <button type="submit" disabled={loading} className="rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
          {loading ? "Buscando…" : "Verificar"}
        </button>
      </form>

      {error && (
        <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800" role="alert">
          {error}
        </p>
      )}

      {ticket && (
        <div className="mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-stone-500">Boleto</p>
              <p className="font-mono text-xl font-bold text-stone-900">{ticket.code}</p>
              <p className="mt-1 text-sm text-stone-700">Número <strong>#{ticket.number}</strong> · {statusLabel(ticket.status)}</p>
              {ticket.buyerName && <p className="text-sm text-stone-500">A nombre de {ticket.buyerName}</p>}
            </div>
            {isWinner ? (
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">🏆 ¡GANADOR!</span>
            ) : (
              <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-600">Sin premio</span>
            )}
          </div>
          {raffle && (
            <div className="mt-4 border-t border-stone-200 pt-4 text-sm">
              <p className="font-semibold text-stone-900">{raffle.title}</p>
              <p className="text-stone-600">Premio: {raffle.prize}</p>
              <p className="text-stone-500">Estado de la rifa: {statusLabel(raffle.status)}</p>
              {raffle.status === "GANADOR_PUBLICADO" || raffle.status === "FINALIZADA" ? (
                <Link href={`/sorteo/${raffle.id}`} className="mt-2 inline-block font-semibold text-orange-600 hover:underline">
                  Ver resultado del sorteo →
                </Link>
              ) : null}
            </div>
          )}
          {ticket.createdAt && formatDate(ticket.createdAt) !== "—" && (
            <p className="mt-3 text-xs text-stone-400">Comprado el {formatDate(ticket.createdAt)}</p>
          )}
        </div>
      )}
    </div>
  );
}
