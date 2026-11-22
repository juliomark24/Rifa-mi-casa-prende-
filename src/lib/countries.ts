// Configuración Internacional — perfil por país (plan §1.5, §2.9).
// Estados de un país: BORRADOR → CONFIGURACION → REVISION → ACTIVO.
// Clasificación A/B/C visible en el panel: A = activable por configuración,
// B = necesita una nueva integración de pagos, C = pendiente de revisión
// legal/comercial/cumplimiento.
//
// GATE DE ACTIVACIÓN (P18): un país solo se activa si legalVerified=true
// Y providerVerified=true para ese país. El gate se aplica ÚNICAMENTE en
// la transición de activación (POST /api/admin/countries/[id]/activate).
// NO se revoca nada existente: el seed dejó DO como ACTIVO con
// legalVerified=false/providerVerified=false (estado pre-lanzamiento) y
// ese registro NO se toca — el gate no se aplica retroactivamente a
// países ya activos, solo a nuevas activaciones.
import type { Country, CountryClassification, CountryStatus } from "../generated/prisma/client";

export const COUNTRY_STATUSES: CountryStatus[] = [
  "BORRADOR",
  "CONFIGURACION",
  "REVISION",
  "ACTIVO",
];

/** Estados en los que el país NO permite publicar rifas (§2.9). */
export const COUNTRY_INACTIVE_STATUSES: CountryStatus[] = [
  "BORRADOR",
  "CONFIGURACION",
  "REVISION",
];

export const COUNTRY_CLASSIFICATION_LABELS: Record<CountryClassification, string> = {
  A: "Activable por configuración (proveedores ya integrados)",
  B: "Necesita una nueva integración de pagos",
  C: "Pendiente de revisión legal, comercial o de cumplimiento",
};

export type CountryGateCheck = {
  ok: boolean;
  reasons: string[];
};

/**
 * Gate de activación por país (P18, plan §1.5/§2.9): verificación legal +
 * proveedor que acepta la actividad de rifas en ese mercado. Devuelve los
 * motivos exactos que faltan; si `ok` es false, la activación responde 409.
 */
export function checkActivationGate(country: {
  legalVerified: boolean;
  providerVerified: boolean;
}): CountryGateCheck {
  const reasons: string[] = [];
  if (!country.legalVerified) {
    reasons.push("Verificación legal pendiente para este país");
  }
  if (!country.providerVerified) {
    reasons.push("Proveedor de pagos no verificado para la actividad de rifas en este mercado");
  }
  return { ok: reasons.length === 0, reasons };
}

/** Un país solo vende boletos cuando está ACTIVO (§2.9). */
export function countryAllowsRaffles(country: { status: CountryStatus }): boolean {
  return country.status === "ACTIVO";
}

/** Perfil completo de un país para el panel de Configuración Internacional. */
export type CountryProfile = {
  id: string;
  code: string;
  name: string;
  flag: string | null;
  currencyCode: string;
  currencySymbol: string;
  currencyFormat: string | null;
  defaultLanguage: string;
  availableLanguages: string[];
  timezone: string;
  dateFormat: string;
  timeFormat: string | null;
  allowedCountries: string[] | null;
  blockedCountries: string[] | null;
  legalConfig: unknown;
  notificationConfig: unknown;
  refundRules: unknown;
  classification: CountryClassification;
  classificationLabel: string;
  status: CountryStatus;
  legalVerified: boolean;
  providerVerified: boolean;
  gate: CountryGateCheck;
  allowsRaffles: boolean;
};

export function buildCountryProfile(country: Country): CountryProfile {
  const gate = checkActivationGate(country);
  return {
    id: country.id,
    code: country.code,
    name: country.name,
    flag: country.flag,
    currencyCode: country.currencyCode,
    currencySymbol: country.currencySymbol,
    currencyFormat: country.currencyFormat,
    defaultLanguage: country.defaultLanguage,
    availableLanguages: (country.availableLanguages as string[]) ?? ["es"],
    timezone: country.timezone,
    dateFormat: country.dateFormat,
    timeFormat: country.timeFormat,
    allowedCountries: (country.allowedCountries as string[] | null) ?? null,
    blockedCountries: (country.blockedCountries as string[] | null) ?? null,
    legalConfig: country.legalConfig,
    notificationConfig: country.notificationConfig,
    refundRules: country.refundRules,
    classification: country.classification,
    classificationLabel: COUNTRY_CLASSIFICATION_LABELS[country.classification],
    status: country.status,
    legalVerified: country.legalVerified,
    providerVerified: country.providerVerified,
    gate,
    allowsRaffles: countryAllowsRaffles(country),
  };
}

/**
 * Los 16 campos del flujo "Agregar país" (plan §2.9). Las comisiones de
 * procesamiento y los límites de transacción se guardan por método y
 * proveedor en CountryPaymentConfig (ver countryCreateSchema).
 */
export const COUNTRY_CREATE_FIELDS = [
  "name",
  "flag",
  "code",
  "currencyCode",
  "currencySymbol",
  "currencyFormat",
  "defaultLanguage",
  "availableLanguages",
  "timezone",
  "dateFormat",
  "timeFormat",
  "paymentMethods",
  "legalConfig",
  "allowedCountries",
  "blockedCountries",
  "status",
  "notificationConfig",
  "refundRules",
  "classification",
  "legalVerified",
  "providerVerified",
] as const;
