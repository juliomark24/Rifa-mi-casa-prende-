"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "./clientApi";
import type { Country, PaymentMethod, ProviderIntegration } from "./types";

/**
 * Integraciones de pago — Configuración Internacional (aclaración del
 * dueño, 21 nov 2026, 17:39 AST): las integraciones se gestionan desde el
 * panel admin, sin tocar código.
 *
 * S9-int: la versión anterior derivaba el estado de GET
 * /api/admin/payment-methods (ruta que NO existía) y tenía el botón de
 * prueba en sandbox deshabilitado "hasta que el backend lo exponga".
 * Ahora usa los endpoints reales del registro de S2:
 *  - GET /api/admin/integrations → estado de cada proveedor preintegrado
 *    (código, nombre, tipo, status, sandboxMode, credentialsConfigured,
 *    credentialKeys, authorizedForRaffles, última prueba de sandbox,
 *    gate {ok, reasons}).
 *  - POST /api/admin/integrations/[provider]/test-sandbox → prueba real
 *    en sandbox (sin credenciales/integración → 503 NOT_CONFIGURED).
 *  - PATCH /api/admin/payment-providers/[id] con {credentials: {...}}
 *    (solo campos no vacíos; se cifran AES-256-GCM y nunca se devuelven),
 *    sandboxMode y authorizedForRaffles. Secretos sueltos → 400.
 *  - POST /api/admin/payment-providers/[id]/activate (gate regla 6) y
 *    /deactivate.
 *
 * Proveedores PREINTEGRADOS (adaptador existe en el backend): Azul,
 * CardNet, PayPal y transferencia manual. Mercado Pago es Fase 2: su
 * adaptador aún no existe, así que NO se ofrece como conectable
 * (distinción A/B/C del plan: una pasarela nueva necesita su adaptador
 * desarrollado una vez antes de poder configurarse).
 *
 * Ninguna pasarela es operativa hasta verificación real + autorización
 * para rifas + conciliación (regla 6 del plan). En Fase 1 solo
 * MANUAL_TRANSFER es operativo; PAYPAL/AZUL/CARDNET responden 503 hasta
 * verificar. Códigos de proveedor (AZUL, CARDNET) ≠ códigos de método
 * (AZUL_CARD, CARDNET_CARD).
 */

interface ProviderDef {
  key: string;
  name: string;
  description: string;
  phase2?: boolean;
}

const PREINTEGRATED: ProviderDef[] = [
  {
    key: "MANUAL_TRANSFER",
    name: "Transferencia manual",
    description: "Respaldo desde el día uno: el admin verifica el comprobante y confirma el pago. No necesita credenciales.",
  },
  {
    key: "PAYPAL",
    name: "PayPal",
    description: "Puente rápido mientras se completa la afiliación local. Requiere cuenta PayPal Business y webhook firmado.",
  },
  {
    key: "AZUL",
    name: "Azul (Banco Popular)",
    description: "Pasarela local RD para tarjetas. Requiere empresa formalizada (RNC, cuenta comercial) y homologación.",
  },
  {
    key: "CARDNET",
    name: "CardNet (Banreservas)",
    description: "Pasarela local RD para tarjetas. Requiere empresa formalizada (RNC, cuenta comercial) y homologación.",
  },
];

const FUTURE: ProviderDef[] = [
  {
    key: "MERCADO_PAGO",
    name: "Mercado Pago",
    description: "Fase 2. Su adaptador aún no existe en el backend: no se puede conectar hasta desarrollar la integración una vez.",
    phase2: true,
  },
];

function ProviderCard({
  def,
  integration,
  providerId,
  onChanged,
}: {
  def: ProviderDef;
  integration: ProviderIntegration | undefined;
  providerId: string | undefined;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sandboxMode, setSandboxMode] = useState(integration?.sandboxMode ?? true);
  const [authorized, setAuthorized] = useState(integration?.authorizedForRaffles ?? false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [merchantId, setMerchantId] = useState("");

  const status = integration?.status ?? "NO_OPERATIVO";
  const operative = status === "OPERATIVO";
  const gate = integration?.gate;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!providerId) {
      setError("Proveedor no registrado en BD; ejecuta el seed o crea el proveedor.");
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const credentials: Record<string, string> = {};
      if (clientId.trim()) credentials.clientId = clientId.trim();
      if (clientSecret.trim()) credentials.clientSecret = clientSecret.trim();
      if (merchantId.trim()) credentials.merchantId = merchantId.trim();
      const body: Record<string, unknown> = { sandboxMode, authorizedForRaffles: authorized };
      if (Object.keys(credentials).length > 0) body.credentials = credentials;
      const res = await clientApi(`/api/admin/payment-providers/${providerId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setClientId("");
      setClientSecret("");
      setMerchantId("");
      setNotice("Integración guardada. Recuerda: la pasarela solo es operativa tras la verificación real (regla 6).");
      setOpen(false);
      onChanged();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function testSandbox() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await clientApi<{ ok?: boolean; message?: string }>(
        `/api/admin/integrations/${def.key}/test-sandbox`,
        { method: "POST" },
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(res.data?.message ?? "Prueba de sandbox superada.");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function toggleOperative() {
    if (!providerId) {
      setError("Proveedor no registrado en BD; ejecuta el seed o crea el proveedor.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const action = operative ? "deactivate" : "activate";
      if (!operative && !window.confirm("¿Activar este proveedor? Se verifica el gate (credenciales, prueba de sandbox superada y autorización para rifas); si no pasa, la API lo rechaza con el motivo.")) return;
      const res = await clientApi(`/api/admin/payment-providers/${providerId}/${action}`, { method: "POST" });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(operative ? "Proveedor desactivado." : "Proveedor activado tras pasar el gate.");
      onChanged();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-bold text-stone-900">{def.name}</h3>
          <p className="mt-1 text-sm text-stone-600">{def.description}</p>
          <p className="mt-1 font-mono text-xs text-stone-500">{def.key}</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${
            operative
              ? "bg-emerald-100 text-emerald-800"
              : integration
                ? "bg-amber-100 text-amber-800"
                : "bg-stone-100 text-stone-600"
          }`}
        >
          {operative ? "Operativo" : integration ? "No operativo" : "No registrado"}
        </span>
      </div>

      {integration && (
        <dl className="mt-3 space-y-1 text-sm text-stone-700">
          <div>
            <dt className="inline font-semibold">Modo: </dt>
            <dd className="inline">{integration.sandboxMode ? "sandbox" : "producción"}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">Credenciales: </dt>
            <dd className="inline">
              {integration.credentialsConfigured
                ? `configuradas (${integration.credentialKeys.join(", ") || "sin claves visibles"})`
                : "no configuradas"}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Autorizado para rifas: </dt>
            <dd className="inline">{integration.authorizedForRaffles ? "sí" : "no"}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">Última prueba de sandbox: </dt>
            <dd className="inline">
              {integration.lastSandboxTestAt
                ? `${integration.lastSandboxTestPassed ? "superada" : "fallida"} (${new Date(integration.lastSandboxTestAt).toLocaleDateString("es-DO")})`
                : "nunca"}
            </dd>
          </div>
          {gate && !gate.ok && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span className="font-semibold">Falta para activar: </span>
              {gate.reasons.join("; ")}
            </div>
          )}
          {gate?.ok && !operative && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Gate superado: se puede activar.
            </div>
          )}
        </dl>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800" role="status">
          {notice}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-700"
        >
          Configurar
        </button>
        <button
          type="button"
          disabled={busy || def.key === "MANUAL_TRANSFER"}
          title={def.key === "MANUAL_TRANSFER" ? "La transferencia manual no tiene integración externa que probar" : "Probar la integración en sandbox"}
          onClick={testSandbox}
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Probando…" : "Probar en sandbox"}
        </button>
        {integration && (
          <button
            type="button"
            disabled={busy}
            onClick={toggleOperative}
            className={`rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-50 ${
              operative ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"
            }`}
          >
            {busy ? "…" : operative ? "Desactivar" : "Activar"}
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={save} className="mt-4 grid gap-3 border-t border-stone-200 pt-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm font-medium text-stone-700">
            <input type="checkbox" checked={sandboxMode} onChange={(e) => setSandboxMode(e.target.checked)} className="h-4 w-4 accent-orange-600" />
            Modo sandbox (pruebas)
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-stone-700">
            <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="h-4 w-4 accent-orange-600" />
            Autorizado por el proveedor para la actividad de rifas
          </label>
          {def.key !== "MANUAL_TRANSFER" && (
            <>
              <p className="text-xs text-stone-500 sm:col-span-2">
                Credenciales del proveedor: se escriben como contraseña y nunca se muestran los valores guardados.
                Deja un campo en blanco para conservar el valor actual. Se cifran en BD.
              </p>
              <label className="block text-sm font-medium text-stone-700">
                Client ID / clave pública
                <input type="password" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="••••••••" />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                Client Secret / clave privada
                <input type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="••••••••" />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                Merchant ID / afiliación (si aplica)
                <input type="password" autoComplete="off" value={merchantId} onChange={(e) => setMerchantId(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="••••••••" />
              </label>
            </>
          )}
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
              {busy ? "Guardando…" : "Guardar integración"}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

export default function PaymentIntegrations({ methods, countries }: { methods: PaymentMethod[]; countries: Country[] }) {
  const router = useRouter();
  const [countryCode, setCountryCode] = useState(countries[0]?.code ?? "DO");
  const [integrations, setIntegrations] = useState<ProviderIntegration[]>([]);
  const [providerIds, setProviderIds] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [intRes, provRes] = await Promise.all([
        clientApi<{ data: ProviderIntegration[] }>("/api/admin/integrations"),
        clientApi<{ data: Array<{ id: string; code: string }> }>("/api/admin/payment-providers"),
      ]);
      if (!intRes.ok) {
        setLoadError(intRes.error);
        return;
      }
      setIntegrations(intRes.data.data ?? []);
      if (provRes.ok) {
        const map: Record<string, string> = {};
        for (const p of provRes.data.data ?? []) map[p.code] = p.id;
        setProviderIds(map);
      }
    } catch {
      setLoadError("No se pudieron cargar las integraciones.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const country = useMemo(() => countries.find((c) => c.code === countryCode), [countries, countryCode]);
  const currency = country?.currencyCode ?? country?.currency ?? "DOP";
  const countryMethods = useMemo(
    () => methods.filter((m) => m.country === countryCode),
    [methods, countryCode]
  );
  const byProvider = useMemo(
    () => Object.fromEntries(integrations.map((i) => [i.provider, i])),
    [integrations]
  );

  return (
    <section id="integraciones" className="mt-10">
      <h2 className="text-2xl font-black text-stone-900">Integraciones de pago</h2>
      <p className="mt-1 text-sm text-stone-600">
        Conecta, configura, activa o desactiva cada proveedor desde aquí, sin tocar código. Solo se ofrecen los
        proveedores con adaptador ya integrado; una pasarela nueva aparece cuando su adaptador existe en el backend.
        Ninguna pasarela es operativa hasta la verificación real (regla 6): en Fase 1 solo la transferencia manual
        opera; PayPal, Azul y CardNet responden 503 hasta verificar.
      </p>

      {loading && <p className="mt-4 text-sm text-stone-500">Cargando integraciones…</p>}
      {loadError && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
          {loadError}
        </p>
      )}

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {PREINTEGRATED.map((def) => (
          <ProviderCard
            key={def.key}
            def={def}
            integration={byProvider[def.key]}
            providerId={providerIds[def.key]}
            onChanged={() => {
              load();
              router.refresh();
            }}
          />
        ))}
      </div>

      <h3 className="mt-8 text-lg font-bold text-stone-900">No disponibles todavía</h3>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {FUTURE.map((def) => (
          <article key={def.key} className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-5">
            <h4 className="font-bold text-stone-700">{def.name}</h4>
            <p className="mt-1 text-sm text-stone-600">{def.description}</p>
            <span className="mt-3 inline-block rounded-full bg-stone-200 px-2.5 py-1 text-xs font-bold text-stone-600">
              Fase 2 — adaptador pendiente
            </span>
          </article>
        ))}
      </div>

      <label className="mt-8 block max-w-xs text-sm font-medium text-stone-700">
        País de los métodos configurados
        <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2">
          {countries.length === 0 && <option value="DO">DO — República Dominicana</option>}
          {countries.map((c) => (
            <option key={c.id} value={c.code}>
              {c.code} — {c.name} ({c.currencyCode ?? c.currency})
            </option>
          ))}
        </select>
      </label>

      {countryMethods.length > 0 && (
        <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold uppercase tracking-wide text-stone-500">
            Métodos configurados en {countryCode} ({currency}) ({countryMethods.length})
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-stone-700">
            {countryMethods.map((m) => (
              <li key={m.id}>
                <strong>{m.label}</strong> · <span className="font-mono text-xs">{m.code}</span> ·{" "}
                {m.enabled ? "habilitado" : "deshabilitado"}
                {m.environment ? ` · ${m.environment}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
