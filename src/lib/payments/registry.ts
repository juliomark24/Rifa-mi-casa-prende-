// Registro de adaptadores de pago (aclaración del dueño 21 nov 2026, 17:39 AST).
//
// El panel admin (Configuración Internacional) CONECTA, CONFIGURA,
// ACTIVA/DESACTIVA proveedores y métodos por país, introduce credenciales
// de forma segura (solo como referencia — nunca en claro en la BD),
// prueba en sandbox y ve el estado de cada integración — todo desde el
// panel, sin tocar código, para los proveedores YA integrados.
//
// Proveedores PREINTEGRADOS desde el inicio: Azul, CardNet, PayPal y
// transferencia manual (Mercado Pago en Fase 2, según el plan).
// Cada proveedor es un adaptador aislado que implementa PaymentProviderAdapter:
// añadir uno nuevo no toca el núcleo (distinción A/B/C sin cambios: una
// pasarela COMPLETAMENTE NUEVA sigue necesitando su adaptador desarrollado
// una vez, con pruebas en sandbox; después queda configurable desde el panel).
//
// REGLA 6 DEL PLAN — SIGUE VIGENTE: ningún proveedor se considera operativo
// hasta verificar su integración real + autorización para rifas +
// conciliación. En Fase 1 SOLO la transferencia manual es operativa;
// Azul, CardNet y PayPal quedan como adaptadores preintegrados con estado
// NO_OPERATIVO y responden 503 NOT_CONFIGURED hasta esa verificación.
// La implementación real de cobros/webhooks de Azul/CardNet/PayPal es S5.
//
// S5 — verificación de firma de webhook (plan §2.2, P4):
//  - Azul / CardNet: HMAC-SHA256 del cuerpo crudo con el secreto compartido
//    (`webhookSecret` en las credenciales cifradas del panel, o la variable
//    de entorno `AZUL_WEBHOOK_SECRET` / `CARDNET_WEBHOOK_SECRET`). La firma
//    llega en el header `x-signature` (hex o base64) y se compara en tiempo
//    constante. Sin secreto configurado no hay nada que verificar: 503.
//  - PayPal: NO usa HMAC compartido; la verificación real es la llamada
//    server-to-server a la API `POST /v1/notifications/verify-webhook-
//    signature` con las credenciales (`clientId`, `clientSecret`,
//    `webhookId`) y los headers `paypal-transmission-*`. Sin esas
//    credenciales no se verifica nada (503 NOT_CONFIGURED); nunca se
//    inventa una verificación PayPal.
//  - Transferencia manual: no tiene webhooks; la verifica un admin.
import crypto from "node:crypto";
import { notConfigured } from "../errors";
import type { PaymentProvider } from "../../generated/prisma/client";
import { decryptText, encryptText } from "../crypto";
import { db } from "../db";

export type ProviderCode = "MANUAL_TRANSFER" | "PAYPAL" | "AZUL" | "CARDNET";

export type ProviderType = "MANUAL" | "GATEWAY";

export type SandboxTestResult = {
  ok: boolean;
  provider: ProviderCode;
  message: string;
  checkedAt: Date;
};

export type ChargeInput = {
  orderId: string;
  orderCode: string;
  amount: number; // entero, unidades mayores
  currency: string;
  buyerEmail: string;
  buyerName: string;
};

export type ChargeResult = {
  status: "PENDING_MANUAL_VERIFICATION" | "PENDING_PROVIDER" | "APPROVED";
  providerRef?: string;
  instructions?: string;
  redirectUrl?: string;
};

export type WebhookVerifyOptions = {
  /** Secreto compartido HMAC (Azul/CardNet). */
  secret?: string;
  /** Headers del webhook (PayPal necesita los `paypal-transmission-*`). */
  headers?: Record<string, string>;
  /** Credenciales descifradas del proveedor (PayPal: clientId, clientSecret, webhookId). */
  credentials?: Record<string, string>;
};

/**
 * Interfaz única que implementa cada pasarela (plan §1.5, §2.2).
 * S5 implementa la verificación real de firma de webhook de cada adaptador;
 * los cobros de Azul/CardNet/PayPal siguen siendo skeleton NO operativo
 * (regla 6) + el adaptador manual operativo.
 */
export interface PaymentProviderAdapter {
  code: ProviderCode;
  name: string;
  type: ProviderType;
  /** ¿Tiene integración real verificada? Solo manual en Fase 1. */
  isPreintegrated: boolean;
  createCharge(input: ChargeInput): Promise<ChargeResult>;
  /**
   * Verifica la firma de un webhook contra el cuerpo CRUDO (sin parsear).
   * Sin credenciales/secreto que verificar lanza 503 NOT_CONFIGURED
   * (regla 6): nunca se acepta un webhook sin verificar. La transferencia
   * manual devuelve false (no tiene webhooks: la verifica un admin).
   */
  verifyWebhookSignature(
    rawBody: string,
    signature: string,
    opts?: WebhookVerifyOptions,
  ): Promise<boolean>;
  refund(providerRef: string, amount: number): Promise<{ ok: boolean; providerRef?: string }>;
  testConnection(): Promise<SandboxTestResult>;
}

// ---------------------------------------------------------------- verificación HMAC
/**
 * HMAC-SHA256 del cuerpo crudo, comparado en tiempo constante.
 * Acepta la firma en hex o en base64. Cualquier error de formato es
 * "firma inválida" (false), nunca una excepción.
 */
export function verifyHmacSha256(rawBody: string, secret: string, signature: string): boolean {
  try {
    const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
    const sig = signature.trim();
    const received = /^[0-9a-fA-F]+$/.test(sig) && sig.length % 2 === 0
      ? Buffer.from(sig, "hex")
      : Buffer.from(sig, "base64");
    if (received.length !== expected.length) return false;
    return crypto.timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

/** Secreto HMAC de un gateway: credenciales del panel o variable de entorno. */
export function gatewayWebhookSecret(
  code: ProviderCode,
  credentials?: Record<string, string> | null,
): string | null {
  return (
    credentials?.webhookSecret?.trim() ||
    process.env[`${code}_WEBHOOK_SECRET`]?.trim() ||
    null
  );
}

/** Credenciales descifradas de un proveedor (valores reales; solo servidor). */
export async function getProviderCredentials(
  code: ProviderCode,
): Promise<Record<string, string> | null> {
  const row = await db.paymentProvider.findUnique({ where: { code } });
  if (!row?.credentialsEncrypted) return null;
  try {
    return JSON.parse(decryptText(row.credentialsEncrypted)) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Slug de la ruta `/api/payments/webhook/[provider]` → código de proveedor. */
export function webhookProviderCode(slug: string): ProviderCode | null {
  switch (slug.trim().toLowerCase()) {
    case "paypal":
      return "PAYPAL";
    case "azul":
      return "AZUL";
    case "cardnet":
      return "CARDNET";
    default:
      return null;
  }
}

function notOperational(adapter: string): never {
  throw notConfigured(
    `Proveedor ${adapter} NO operativo: sin integración real verificada, sin autorización para rifas y sin conciliación (regla 6 del plan v2.2). Solo la transferencia manual es operativa en Fase 1.`,
  );
}

// ---------------------------------------------------------------- manual (operativo)
export const ManualTransferAdapter: PaymentProviderAdapter = {
  code: "MANUAL_TRANSFER",
  name: "Transferencia manual",
  type: "MANUAL",
  isPreintegrated: true,
  async createCharge(input) {
    return {
      status: "PENDING_MANUAL_VERIFICATION",
      instructions:
        "Realiza la transferencia con el código de tu pedido como referencia. " +
        `Pedido ${input.orderCode} por ${input.amount} ${input.currency}. ` +
        "Un administrador verificará el comprobante y confirmará tus boletos.",
    };
  },
  async verifyWebhookSignature() {
    // La transferencia manual no tiene webhooks: la verifica un admin.
    return false;
  },
  async refund() {
    // El reembolso manual lo ejecuta un admin (FINANZAS) con comprobante.
    return { ok: true };
  },
  async testConnection() {
    return {
      ok: true,
      provider: "MANUAL_TRANSFER",
      message: "Transferencia manual operativa: no requiere conexión externa.",
      checkedAt: new Date(),
    };
  },
};

// ---------------------------------------------------------------- skeletons NO operativos (S5)
// Cobros/reembolsos de Azul, CardNet y PayPal siguen en 503 hasta la
// verificación real (regla 6). La verificación de firma de webhook SÍ es
// real (plan §2.2): sin secreto/credenciales que verificar, 503.
function gatewayAdapter(
  code: ProviderCode,
  name: string,
  verify: PaymentProviderAdapter["verifyWebhookSignature"],
): PaymentProviderAdapter {
  return {
    code,
    name,
    type: "GATEWAY",
    isPreintegrated: true,
    async createCharge() {
      return notOperational(name);
    },
    verifyWebhookSignature: verify,
    async refund() {
      return notOperational(name);
    },
    async testConnection() {
      return {
        ok: false,
        provider: code,
        message:
          `${name} NO operativo: faltan credenciales reales, afiliación/homologación, ` +
          "autorización para rifas y conciliación (regla 6).",
        checkedAt: new Date(),
      };
    },
  };
}

/** Azul / CardNet: HMAC-SHA256 del cuerpo crudo con el secreto compartido. */
async function verifyGatewayHmac(
  code: ProviderCode,
  rawBody: string,
  signature: string,
  opts?: WebhookVerifyOptions,
): Promise<boolean> {
  const secret = gatewayWebhookSecret(code, opts?.credentials);
  if (!secret) {
    throw notConfigured(
      `Sin secreto de webhook configurado para ${code}: no se puede verificar la firma (regla 6).`,
    );
  }
  if (!signature || !signature.trim()) return false;
  return verifyHmacSha256(rawBody, secret, signature);
}

/**
 * PayPal: verificación real vía la API de PayPal
 * `POST /v1/notifications/verify-webhook-signature` (no HMAC: PayPal no
 * usa secreto compartido). Requiere credenciales `clientId`,
 * `clientSecret` y `webhookId` + los headers `paypal-transmission-*`.
 * Sin ellas, 503 NOT_CONFIGURED: nunca se acepta un webhook PayPal sin
 * verificar. `PAYPAL_ENV=live` (o credenciales `environment: "live"`)
 * usa api-m.paypal.com; si no, el sandbox.
 */
async function verifyPayPalSignature(
  rawBody: string,
  _signature: string,
  opts?: WebhookVerifyOptions,
): Promise<boolean> {
  const creds = opts?.credentials ?? {};
  const { clientId, clientSecret, webhookId } = creds;
  if (!clientId || !clientSecret || !webhookId) {
    throw notConfigured(
      "PayPal NO operativo: faltan credenciales (clientId, clientSecret, webhookId) para verificar webhooks (regla 6).",
    );
  }
  const headers = opts?.headers ?? {};
  const get = (name: string) =>
    headers[name] ?? headers[name.toLowerCase()] ?? "";
  const authAlgo = get("paypal-auth-algo");
  const certUrl = get("paypal-cert-url");
  const transmissionId = get("paypal-transmission-id");
  const transmissionSig = get("paypal-transmission-sig");
  const transmissionTime = get("paypal-transmission-time");
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    return false;
  }
  let webhookEvent: unknown;
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const live = creds.environment === "live" || process.env.PAYPAL_ENV === "live";
  const base = live ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!tokenRes.ok) return false;
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) return false;
  const verifyRes = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: webhookEvent,
    }),
  });
  if (!verifyRes.ok) return false;
  const verifyJson = (await verifyRes.json()) as { verification_status?: string };
  return verifyJson.verification_status === "SUCCESS";
}

export const AzulAdapter = gatewayAdapter("AZUL", "Azul (Banco Popular)", (raw, sig, opts) =>
  verifyGatewayHmac("AZUL", raw, sig, opts),
);
export const CardNetAdapter = gatewayAdapter("CARDNET", "CardNet (Banreservas)", (raw, sig, opts) =>
  verifyGatewayHmac("CARDNET", raw, sig, opts),
);
export const PayPalAdapter = gatewayAdapter("PAYPAL", "PayPal", verifyPayPalSignature);

// ---------------------------------------------------------------- registro
export const ADAPTERS: Record<ProviderCode, PaymentProviderAdapter> = {
  MANUAL_TRANSFER: ManualTransferAdapter,
  PAYPAL: PayPalAdapter,
  AZUL: AzulAdapter,
  CARDNET: CardNetAdapter,
};

/** Estado por defecto de cada proveedor preintegrado (lo refleja el seed). */
export const ADAPTER_DEFAULT_STATUS: Record<ProviderCode, PaymentProvider["status"]> = {
  MANUAL_TRANSFER: "OPERATIVO",
  PAYPAL: "NO_OPERATIVO",
  AZUL: "NO_OPERATIVO",
  CARDNET: "NO_OPERATIVO",
};

export function getAdapter(code: string): PaymentProviderAdapter {
  const adapter = (ADAPTERS as Record<string, PaymentProviderAdapter | undefined>)[code];
  if (!adapter) throw notConfigured(`Proveedor desconocido: ${code}`);
  return adapter;
}

export function listAdapters(): PaymentProviderAdapter[] {
  return Object.values(ADAPTERS);
}

// ---------------------------------------------------------------- credenciales del panel
/**
 * Credenciales de un proveedor, introducidas desde el panel (PATCH con
 * `{credentials: {...}}`, solo campos no vacíos). Se guardan CIFRADAS
 * (AES-256-GCM) en PaymentProvider.credentialsEncrypted y NUNCA se
 * devuelven por la API. credentialsRef guarda solo el origen y los
 * NOMBRES de los campos presentes (ej. "panel:clientId,clientSecret").
 * Los campos nuevos se fusionan con los ya guardados (solo se
 * sobrescriben los campos no vacíos enviados).
 */
export function mergeProviderCredentials(
  existingEncrypted: string | null,
  incoming: Record<string, unknown>,
): { encrypted: string; ref: string } {
  const current: Record<string, string> = {};
  if (existingEncrypted) {
    try {
      Object.assign(current, JSON.parse(decryptText(existingEncrypted)) as Record<string, string>);
    } catch {
      // Credenciales corruptas: se reemplazan por las nuevas.
    }
  }
  const fresh: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === "string" && value.trim() !== "") {
      fresh[key] = value;
    }
  }
  if (Object.keys(fresh).length === 0) {
    throw new Error("No se envió ninguna credencial con valor (solo campos no vacíos)");
  }
  const merged = { ...current, ...fresh };
  const keys = Object.keys(merged).sort().join(",");
  return { encrypted: encryptText(JSON.stringify(merged)), ref: `panel:${keys}` };
}

/** Nombres de los campos de credenciales guardados (sin valores). */
export function storedCredentialKeys(encrypted: string | null): string[] {
  if (!encrypted) return [];
  try {
    return Object.keys(JSON.parse(decryptText(encrypted)) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Versión pública de un proveedor para la API: sin credentialsEncrypted
 * ni ningún valor de credencial. Incluye `credentialsConfigured` (bool) y
 * `credentialKeys` (nombres de campos) para que el panel muestre el estado.
 */
export function sanitizeProvider<T extends PaymentProvider>(provider: T) {
  const { credentialsEncrypted: _removed, ...rest } = provider as PaymentProvider & {
    credentialsEncrypted?: string | null;
  };
  void _removed;
  return {
    ...rest,
    credentialsConfigured: Boolean(provider.credentialsEncrypted),
    credentialKeys: storedCredentialKeys(provider.credentialsEncrypted ?? null),
  };
}

// ---------------------------------------------------------------- gate de activación (regla 6)
export type GateCheck = { ok: boolean; reasons: string[] };

/**
 * ¿Puede activarse este proveedor? La transferencia manual queda exenta
 * de la prueba de sandbox (no tiene integración externa); el resto exige:
 * credenciales (referencia segura), última prueba de sandbox superada y
 * autorización explícita para la actividad de rifas.
 */
export function providerGateCheck(provider: PaymentProvider): GateCheck {
  const reasons: string[] = [];
  if (provider.code !== "MANUAL_TRANSFER") {
    if (!provider.credentialsRef) {
      reasons.push("Faltan credenciales (introducir referencia segura desde el panel)");
    }
    if (provider.lastSandboxTestPassed !== true) {
      reasons.push("La prueba de sandbox no ha sido superada");
    }
    if (!provider.authorizedForRaffles) {
      reasons.push("Falta la autorización del proveedor para la actividad de rifas");
    }
  }
  return { ok: reasons.length === 0, reasons };
}
