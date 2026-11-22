"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "./clientApi";
import type { PaymentMethodCode } from "./types";

/**
 * POST /api/admin/payment-methods.
 * Códigos v2.2: MANUAL_TRANSFER (único operativo en Fase 1), PAYPAL,
 * AZUL_CARD, CARDNET_CARD (responden 503 NOT_CONFIGURED hasta verificación
 * real, regla 6 del plan). La configuración del proveedor (credenciales,
 * sandbox/producción) se gestiona en /admin/paises → Integraciones de pago.
 */
export default function PaymentMethodCreateForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    country: "DO",
    currency: "DOP",
    code: "MANUAL_TRANSFER" as PaymentMethodCode,
    label: "",
    details: "",
    enabled: true,
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await clientApi("/api/admin/payment-methods", {
        method: "POST",
        body: JSON.stringify({
          country: form.country.trim().toUpperCase(),
          currency: form.currency.trim().toUpperCase(),
          code: form.code,
          label: form.label.trim(),
          details: form.details.trim() || undefined,
          enabled: form.enabled,
        }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setForm({ country: "DO", currency: "DOP", code: "MANUAL_TRANSFER", label: "", details: "", enabled: true });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const inputCls = "mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
  return (
    <form onSubmit={handleSubmit} className="mt-5 grid gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:grid-cols-2">
      <label className="block text-sm font-medium text-stone-700">
        País (ISO)
        <input required value={form.country} onChange={(e) => set("country", e.target.value)} className={inputCls} />
      </label>
      <label className="block text-sm font-medium text-stone-700">
        Moneda
        <input required value={form.currency} onChange={(e) => set("currency", e.target.value)} className={inputCls} />
      </label>
      <label className="block text-sm font-medium text-stone-700">
        Código
        <select value={form.code} onChange={(e) => set("code", e.target.value as PaymentMethodCode)} className={inputCls}>
          <option value="MANUAL_TRANSFER">MANUAL_TRANSFER (transferencia manual)</option>
          <option value="PAYPAL">PAYPAL (PayPal)</option>
          <option value="AZUL_CARD">AZUL_CARD (tarjeta vía Azul)</option>
          <option value="CARDNET_CARD">CARDNET_CARD (tarjeta vía CardNet)</option>
        </select>
      </label>
      <label className="block text-sm font-medium text-stone-700">
        Etiqueta *
        <input required value={form.label} onChange={(e) => set("label", e.target.value)} className={inputCls} placeholder="Ej. Transferencia Banco Popular" />
      </label>
      <label className="block text-sm font-medium text-stone-700 sm:col-span-2">
        Detalles (banco, cuenta, instrucciones…)
        <textarea rows={2} value={form.details} onChange={(e) => set("details", e.target.value)} className={inputCls} />
      </label>
      <label className="flex items-center gap-2 text-sm font-medium text-stone-700">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Habilitado
      </label>
      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 sm:col-span-2" role="alert">{error}</p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={loading} className="rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
          {loading ? "Creando…" : "Crear método de pago"}
        </button>
      </div>
    </form>
  );
}
