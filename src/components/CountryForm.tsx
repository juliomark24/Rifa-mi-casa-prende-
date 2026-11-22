"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { statusLabel } from "./format";
import { clientApi } from "./clientApi";
import type { Country, CountryClass, CountryStatus } from "./types";

const inputCls = "mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
const labelCls = "block text-sm font-medium text-stone-700";

/**
 * "Agregar país" — los campos del plan §2.9 que guarda el endpoint de
 * países (POST /api/admin/countries · PATCH /api/admin/countries/[id]).
 *
 * S9-int: el formulario enviaba los campos con los nombres del plan
 * (`currency`, `languages`, `paymentMethods` como texto, `providers`,
 * `processingFees`, `transactionLimits`, `participationRules`, `terms`,
 * `notificationsConfig`, `chargebackRules`, estado ACTIVO), pero el
 * schema de la API espera otros nombres (`currencyCode`,
 * `availableLanguages`, `notificationConfig`) y la creación rechazaba
 * el POST con 400 (falta `currencyCode`, obligatorio). Además ACTIVO no
 * se admite en POST/PATCH: activar exige el gate de
 * POST /api/admin/countries/[id]/activate. Métodos, proveedores,
 * comisiones y límites NO viven en el país: se configuran por país en
 * Métodos de pago e Integraciones de pago (CountryPaymentConfig).
 */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return "";
}

export default function CountryForm({ country }: { country?: Country }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: country?.name ?? "",
    code: country?.code ?? "",
    flag: country?.flag ?? "",
    currencyCode: country?.currencyCode ?? country?.currency ?? "",
    currencySymbol: country?.currencySymbol ?? "",
    currencyFormat: country?.currencyFormat ?? "",
    availableLanguages: Array.isArray(country?.availableLanguages)
      ? (country.availableLanguages as string[]).join(", ")
      : (asText(country?.availableLanguages ?? country?.languages) ?? ""),
    defaultLanguage: country?.defaultLanguage ?? "",
    timezone: country?.timezone ?? "",
    dateFormat: country?.dateFormat ?? "",
    timeFormat: country?.timeFormat ?? "",
    allowedCountries: Array.isArray(country?.allowedCountries) ? (country.allowedCountries as string[]).join(", ") : (asText(country?.allowedCountries) ?? ""),
    blockedCountries: Array.isArray(country?.blockedCountries) ? (country.blockedCountries as string[]).join(", ") : (asText(country?.blockedCountries) ?? ""),
    legalConfig: asText(country?.legalConfig),
    status: (country?.status ?? "BORRADOR") as CountryStatus,
    classification: (country?.classification ?? "C") as CountryClass,
    notificationConfig: asText(country?.notificationConfig),
    refundRules: asText(country?.refundRules),
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const split = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Solo los campos que acepta countryCreateSchema/countryPatchSchema.
      const body = {
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        flag: form.flag.trim() || undefined,
        currencyCode: form.currencyCode.trim().toUpperCase(),
        currencySymbol: form.currencySymbol.trim(),
        currencyFormat: form.currencyFormat.trim() || undefined,
        availableLanguages: split(form.availableLanguages),
        defaultLanguage: form.defaultLanguage.trim() || undefined,
        timezone: form.timezone.trim(),
        dateFormat: form.dateFormat.trim() || undefined,
        timeFormat: form.timeFormat.trim() || undefined,
        allowedCountries: split(form.allowedCountries),
        blockedCountries: split(form.blockedCountries),
        legalConfig: form.legalConfig.trim() || undefined,
        status: form.status,
        classification: form.classification,
        notificationConfig: form.notificationConfig.trim() || undefined,
        refundRules: form.refundRules.trim() || undefined,
      };
      const url = country ? `/api/admin/countries/${country.id}` : "/api/admin/countries";
      const res = await clientApi(url, { method: country ? "PATCH" : "POST", body: JSON.stringify(body) });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/admin/paises");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:grid-cols-2">
      <label className={labelCls}>
        1. Nombre del país *
        <input required value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder="República Dominicana" />
      </label>
      <label className={labelCls}>
        2. Código ISO (alpha-2) *
        <input required value={form.code} onChange={(e) => set("code", e.target.value)} className={inputCls} placeholder="DO" maxLength={2} />
      </label>
      <label className={labelCls}>
        Bandera (emoji o URL)
        <input value={form.flag} onChange={(e) => set("flag", e.target.value)} className={inputCls} placeholder="🇩🇴" />
      </label>
      <label className={labelCls}>
        3. Moneda (código ISO 4217) *
        <input required value={form.currencyCode} onChange={(e) => set("currencyCode", e.target.value)} className={inputCls} placeholder="DOP" />
      </label>
      <label className={labelCls}>
        4. Símbolo de moneda *
        <input required value={form.currencySymbol} onChange={(e) => set("currencySymbol", e.target.value)} className={inputCls} placeholder="RD$" />
      </label>
      <label className={labelCls}>
        Formato monetario
        <input value={form.currencyFormat} onChange={(e) => set("currencyFormat", e.target.value)} className={inputCls} placeholder="RD$ 1,000" />
      </label>
      <label className={labelCls}>
        5. Idiomas disponibles (separados por coma)
        <input value={form.availableLanguages} onChange={(e) => set("availableLanguages", e.target.value)} className={inputCls} placeholder="es, en" />
      </label>
      <label className={labelCls}>
        Idioma predeterminado
        <input value={form.defaultLanguage} onChange={(e) => set("defaultLanguage", e.target.value)} className={inputCls} placeholder="es" />
      </label>
      <label className={labelCls}>
        6. Zona horaria (IANA) *
        <input required value={form.timezone} onChange={(e) => set("timezone", e.target.value)} className={inputCls} placeholder="America/Santo_Domingo" />
      </label>
      <label className={labelCls}>
        7. Formato de fecha y hora
        <span className="flex gap-2">
          <input value={form.dateFormat} onChange={(e) => set("dateFormat", e.target.value)} className={inputCls} placeholder="DD/MM/YYYY" />
          <input value={form.timeFormat} onChange={(e) => set("timeFormat", e.target.value)} className={inputCls} placeholder="HH:mm" />
        </span>
      </label>
      <label className={labelCls}>
        13. Países permitidos para participar (coma, ISO)
        <input value={form.allowedCountries} onChange={(e) => set("allowedCountries", e.target.value)} className={inputCls} placeholder="DO" />
      </label>
      <label className={labelCls}>
        Países restringidos (coma, ISO)
        <input value={form.blockedCountries} onChange={(e) => set("blockedCountries", e.target.value)} className={inputCls} placeholder="Ej. CU, VE" />
      </label>
      <label className={`${labelCls} sm:col-span-2`}>
        14. Configuración legal y términos aplicables
        <textarea rows={2} value={form.legalConfig} onChange={(e) => set("legalConfig", e.target.value)} className={inputCls} placeholder="Licencia, registro, textos legales del país…" />
      </label>
      <label className={labelCls}>
        15. Estado de activación *
        <select value={form.status} onChange={(e) => set("status", e.target.value as CountryStatus)} className={inputCls}>
          {(["BORRADOR", "CONFIGURACION", "REVISION"] as CountryStatus[]).map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-stone-500">
          Solo un país ACTIVO puede vender boletos. Activar exige pasar el gate legal + proveedor (botón Activar en
          la lista de países); no se puede crear ya activo.
        </span>
      </label>
      <label className={labelCls}>
        Clasificación A / B / C *
        <select value={form.classification} onChange={(e) => set("classification", e.target.value as CountryClass)} className={inputCls}>
          <option value="A">A — Activable por configuración</option>
          <option value="B">B — Necesita nueva integración</option>
          <option value="C">C — Pendiente de revisión legal/comercial</option>
        </select>
      </label>
      <label className={`${labelCls} sm:col-span-2`}>
        16a. Configuración de notificaciones
        <input value={form.notificationConfig} onChange={(e) => set("notificationConfig", e.target.value)} className={inputCls} placeholder="Ej. email + WhatsApp en español" />
      </label>
      <label className={`${labelCls} sm:col-span-2`}>
        16b. Reglas de reembolsos y contracargos
        <textarea rows={2} value={form.refundRules} onChange={(e) => set("refundRules", e.target.value)} className={inputCls} placeholder="Plazos, condiciones de devolución, gestión de contracargos…" />
      </label>

      <p className="rounded-xl bg-stone-50 px-4 py-3 text-xs text-stone-600 sm:col-span-2">
        Métodos de pago, proveedores, comisiones de procesamiento y límites de transacción no se guardan en el país:
        se configuran por país en{" "}
        <a href="/admin/metodos-pago" className="font-semibold text-orange-600 hover:underline">
          Métodos de pago
        </a>{" "}
        y en la sección{" "}
        <a href="/admin/paises#integraciones" className="font-semibold text-orange-600 hover:underline">
          Integraciones de pago
        </a>
        .
      </p>

      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 sm:col-span-2" role="alert">
          {error}
        </p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={loading} className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
          {loading ? "Guardando…" : country ? "Guardar cambios" : "Agregar país"}
        </button>
      </div>
    </form>
  );
}
