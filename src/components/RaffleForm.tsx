"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { statusLabel } from "./format";
import { clientApi } from "./clientApi";
import type { Raffle, RaffleStatus } from "./types";

const inputCls = "mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
const labelCls = "block text-sm font-medium text-stone-700";

const STATUS_OPTIONS: RaffleStatus[] = [
  "BORRADOR",
  "PENDIENTE_APROBACION",
  "PROGRAMADA",
  "ACTIVA",
  "PAUSADA",
  "AGOTADA",
  "CERRADA",
  "EN_SORTEO",
  "GANADOR_PUBLICADO",
  "FINALIZADA",
  "CANCELADA",
];

/**
 * Formulario de crear/editar rifa (admin).
 * POST /api/admin/raffles · PATCH /api/admin/raffles/[id].
 * Los cambios de estado con ventas (precio, premio, fecha) requieren
 * aprobación y quedan en auditoría: se hacen por PATCH y el servidor
 * decide; para avanzar el ciclo de vida usa la transición en /admin/rifas.
 */
export default function RaffleForm({ raffle }: { raffle?: Raffle }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    title: raffle?.title ?? "",
    description: raffle?.description ?? "",
    prize: raffle?.prize ?? "",
    imageUrl: raffle?.imageUrl ?? "",
    country: raffle?.country ?? "DO",
    currency: raffle?.currency ?? "DOP",
    ticketPrice: String(raffle?.ticketPrice ?? 100),
    totalTickets: String(raffle?.totalTickets ?? 1000),
    drawAt: raffle?.drawAt ? raffle.drawAt.slice(0, 16) : "",
    status: raffle?.status ?? "BORRADOR",
    rules: raffle?.rules ?? "",
    licenseNumber: raffle?.licenseNumber ?? "",
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const body = {
        title: form.title.trim(),
        description: form.description.trim(),
        prize: form.prize.trim(),
        imageUrl: form.imageUrl.trim() || undefined,
        country: form.country.trim().toUpperCase(),
        currency: form.currency.trim().toUpperCase(),
        ticketPrice: Number(form.ticketPrice),
        totalTickets: Number(form.totalTickets),
        drawAt: form.drawAt ? new Date(form.drawAt).toISOString() : undefined,
        status: form.status,
        rules: form.rules.trim() || undefined,
        licenseNumber: form.licenseNumber.trim() || undefined,
      };
      const url = raffle ? `/api/admin/raffles/${raffle.id}` : "/api/admin/raffles";
      const res = await clientApi(url, {
        method: raffle ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/admin/rifas");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:grid-cols-2">
      <label className={labelCls}>
        Título *
        <input required value={form.title} onChange={(e) => set("title", e.target.value)} className={inputCls} />
      </label>
      <label className={labelCls}>
        Premio *
        <input required value={form.prize} onChange={(e) => set("prize", e.target.value)} className={inputCls} placeholder="Ej. iPhone 17 Pro 256GB" />
      </label>
      <label className={`${labelCls} sm:col-span-2`}>
        Descripción *
        <textarea required rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} className={inputCls} />
      </label>
      <label className={`${labelCls} sm:col-span-2`}>
        URL de imagen (opcional)
        <input value={form.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} className={inputCls} placeholder="https://…" />
      </label>
      <label className={labelCls}>
        País (ISO) *
        <input required value={form.country} onChange={(e) => set("country", e.target.value)} className={inputCls} placeholder="DO" />
      </label>
      <label className={labelCls}>
        Moneda *
        <input required value={form.currency} onChange={(e) => set("currency", e.target.value)} className={inputCls} placeholder="DOP" />
      </label>
      <label className={labelCls}>
        Precio por boleto *
        <input required type="number" min={1} value={form.ticketPrice} onChange={(e) => set("ticketPrice", e.target.value)} className={inputCls} />
      </label>
      <label className={labelCls}>
        Total de boletos *
        <input required type="number" min={1} value={form.totalTickets} onChange={(e) => set("totalTickets", e.target.value)} className={inputCls} />
      </label>
      <label className={labelCls}>
        Fecha y hora del sorteo *
        <input required type="datetime-local" value={form.drawAt} onChange={(e) => set("drawAt", e.target.value)} className={inputCls} />
      </label>
      <label className={labelCls}>
        Estado *
        <select value={form.status} onChange={(e) => set("status", e.target.value as Raffle["status"])} className={inputCls}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        N.º de licencia / registro (Hacienda / Pro Consumidor)
        <input value={form.licenseNumber} onChange={(e) => set("licenseNumber", e.target.value)} className={inputCls} placeholder="Si aplica" />
      </label>
      <label className={`${labelCls} sm:col-span-2`}>
        Reglas / bases de la rifa
        <textarea rows={3} value={form.rules} onChange={(e) => set("rules", e.target.value)} className={inputCls} />
      </label>

      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 sm:col-span-2" role="alert">
          {error}
        </p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={loading} className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
          {loading ? "Guardando…" : raffle ? "Guardar cambios" : "Crear rifa"}
        </button>
      </div>
    </form>
  );
}
