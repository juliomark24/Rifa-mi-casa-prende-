"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "./clientApi";

interface Setting {
  key: string;
  value: string;
}

/** GET /api/admin/settings + PATCH /api/admin/settings */
export default function SettingsForm({ initial }: { initial: Setting[] }) {
  const router = useRouter();
  const [settings, setSettings] = useState<Setting[]>(initial);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function updateValue(index: number, value: string) {
    setSettings((s) => s.map((item, i) => (i === index ? { ...item, value } : item)));
  }

  async function saveAll() {
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const res = await clientApi("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSuccess("Configuración guardada.");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  function addSetting() {
    const key = newKey.trim();
    if (!key) {
      setError("Escribe una clave para la nueva configuración.");
      return;
    }
    if (settings.some((s) => s.key === key)) {
      setError(`Ya existe una configuración con la clave "${key}".`);
      return;
    }
    setSettings((s) => [...s, { key, value: newValue }]);
    setNewKey("");
    setNewValue("");
    setError(null);
  }

  return (
    <div>
      <div className="grid gap-4">
        {settings.map((s, i) => (
          <label key={s.key} className="block rounded-2xl border border-stone-200 bg-white p-4 text-sm font-medium text-stone-700 shadow-sm">
            <span className="font-mono text-xs font-bold text-stone-500">{s.key}</span>
            <input
              value={s.value}
              onChange={(e) => updateValue(i, e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            {s.key === "COMMISSION_RATE" && (
              <span className="mt-1 block text-xs text-stone-500">Tasa de comisión de afiliados (0.10 = 10%).</span>
            )}
            {s.key === "RETENTION_DAYS" && (
              <span className="mt-1 block text-xs text-stone-500">Días que la comisión queda retenida tras la confirmación del pago.</span>
            )}
            {s.key === "MIN_WITHDRAWAL" && (
              <span className="mt-1 block text-xs text-stone-500">Retiro mínimo del afiliado (por defecto RD$500 o su equivalente).</span>
            )}
            {s.key === "RESERVATION_MINUTES" && (
              <span className="mt-1 block text-xs text-stone-500">Duración de la reserva de boletos en minutos (por defecto ~10).</span>
            )}
          </label>
        ))}
        {settings.length === 0 && (
          <p className="rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
            No hay configuraciones todavía. Agrega la primera abajo (por ejemplo, COMMISSION_RATE con valor 0.10).
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={saveAll} disabled={loading} className="rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
          {loading ? "Guardando…" : "Guardar configuración"}
        </button>
      </div>

      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-bold text-stone-900">Agregar configuración</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="CLAVE (ej. COMMISSION_RATE)" className="w-64 rounded-lg border border-stone-300 px-3 py-2 font-mono text-sm" />
          <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="Valor" className="w-64 rounded-lg border border-stone-300 px-3 py-2 text-sm" />
          <button type="button" onClick={addSetting} className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100">
            Agregar
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800" role="alert">{error}</p>
      )}
      {success && (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800" role="status">{success}</p>
      )}
    </div>
  );
}
