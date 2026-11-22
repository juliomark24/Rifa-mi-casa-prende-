// Procesador de webhooks de pago (plan §2.2, §2.12, §2.13; P2, P4, P20).
//
// Un webhook nunca se confía por llegar: la ruta verifica la firma ANTES
// de llamar aquí (sin firma válida → 401, sin efectos). Aquí solo se
// procesa el evento ya verificado, con idempotencia por
// (proveedor, eventId) en WebhookEvent: un evento duplicado (o reenviado
// 3 veces por el proveedor) devuelve `duplicate: true` sin repetir
// ningún efecto — ni segundo cobro, ni segundo pedido, ni boletos ni
// comisiones duplicadas.
//
// Extracción de datos (tolerante a los formatos de cada proveedor):
//  - eventId: `id` | `eventId` | `event_id`.
//  - tipo: `type` | `event` | `status` (normalizado a minúsculas).
//  - orderCode: `orderCode` | `order_code` | `metadata.orderCode` |
//    `resource.custom_id` | `custom_id`.
//  - providerRef: `providerRef` | `transactionId` | `resource.id` | `id`.
//  - amount: `amount` | `resource.amount.value` (entero en unidades
//    mayores; un decimal como "100.00" se redondea al entero).
//
// Discrepancias (P21): un pago aprobado sin pedido que lo respalde NO se
// inventa ni se confirma en silencio: se abre un ReconciliationCase
// ABIERTO (`pago-sin-pedido`) y el evento queda procesado con ese
// resultado. Un monto distinto al total del pedido abre
// `monto-distinto` (vía confirmOrderPayment) sin confirmar el parcial.
import { db } from "../db";
import { ApiError } from "../errors";
import { confirmOrderPayment, failOrderPayment, refundOrderPayment } from "./operations";
import type { PaymentProviderAdapter, ProviderCode } from "./registry";

export type WebhookProcessResult = {
  received: boolean;
  duplicate?: boolean;
  action?: string;
  orderCode?: string | null;
  caseId?: string | null;
  error?: string | null;
};

const APPROVED_HINTS = ["completed", "approved", "succeeded", "captured", "aprobado", "confirmado"];
const FAILED_HINTS = ["denied", "failed", "declined", "cancelled", "canceled", "rechazado", "fallido"];
const REFUNDED_HINTS = ["refund", "reembolso", "reversed"];

function getPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Monto del proveedor a entero en unidades mayores (o null si no viene). */
export function parseProviderAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

function hintMatches(type: string, hints: string[]): boolean {
  const t = type.toLowerCase();
  return hints.some((h) => t.includes(h));
}

async function openCase(input: {
  provider: string;
  detail: Record<string, unknown>;
  amount?: number | null;
  currency?: string | null;
}) {
  return db.reconciliationCase.create({
    data: {
      provider: input.provider,
      status: "ABIERTO",
      detail: input.detail as never,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
    },
  });
}

/**
 * Procesa UN evento de webhook ya verificado. El adaptador se inyecta
 * (la ruta pasa el adaptador real del registro; los tests pasan un
 * MockProvider) — este módulo no verifica firmas, solo procesa.
 */
export async function processWebhookEvent(input: {
  provider: ProviderCode;
  eventId: string;
  eventType?: string | null;
  payload: unknown;
  adapter: PaymentProviderAdapter;
}): Promise<WebhookProcessResult> {
  const { provider, eventId } = input;
  const payload = input.payload as Record<string, unknown>;

  // Idempotencia P4: evento ya procesado → sin efectos.
  const existing = await db.webhookEvent.findUnique({
    where: { provider_eventId: { provider, eventId } },
  });
  if (existing?.processedAt) {
    return { received: true, duplicate: true, action: "duplicate-ignored" };
  }
  if (!existing) {
    await db.webhookEvent.create({
      data: { provider, eventId, payload: payload as never },
    });
  }

  const markProcessed = async (error?: string | null) => {
    await db.webhookEvent.update({
      where: { provider_eventId: { provider, eventId } },
      data: { processedAt: new Date(), ...(error !== undefined ? { error } : {}) },
    });
  };

  try {
    const result = await dispatchVerifiedEvent({ provider, eventId, payload, eventType: input.eventType });
    await markProcessed(result.error ?? null);
    return { received: true, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.webhookEvent
      .update({
        where: { provider_eventId: { provider, eventId } },
        data: { error: message.slice(0, 500) },
      })
      .catch(() => undefined);
    throw err;
  }
}

async function dispatchVerifiedEvent(input: {
  provider: ProviderCode;
  eventId: string;
  eventType?: string | null;
  payload: Record<string, unknown>;
}): Promise<Omit<WebhookProcessResult, "received">> {
  const { provider, eventId, payload } = input;
  const type =
    input.eventType ??
    asString(payload.type) ??
    asString(payload.event) ??
    asString(payload.status) ??
    "";
  const orderCode =
    asString(payload.orderCode) ??
    asString(payload.order_code) ??
    asString(getPath(payload, "metadata.orderCode")) ??
    asString(getPath(payload, "resource.custom_id")) ??
    asString(payload.custom_id);
  const providerRef =
    asString(payload.providerRef) ??
    asString(payload.transactionId) ??
    asString(getPath(payload, "resource.id")) ??
    asString(payload.id);
  const amount =
    parseProviderAmount(payload.amount) ?? parseProviderAmount(getPath(payload, "resource.amount.value"));

  // Contracargo: no se mueve dinero en silencio; caso para S6/fraude.
  if (type.toLowerCase().includes("chargeback") || type.toLowerCase().includes("contracargo")) {
    const c = await openCase({
      provider,
      detail: {
        kind: "contracargo",
        eventId,
        orderCode,
        providerRef,
        amount,
        reason: "contracargo notificado por el proveedor; S6/fraude debe resolverlo (no se mueve dinero en silencio)",
      },
      amount,
    });
    return { action: "case-contracargo", orderCode, caseId: c.id };
  }

  if (hintMatches(type, REFUNDED_HINTS)) {
    const payment = await findPayment(provider, providerRef, orderCode);
    if (!payment) {
      const c = await openCase({
        provider,
        detail: { kind: "reembolso-sin-pedido", eventId, orderCode, providerRef, amount },
        amount,
      });
      return { action: "case-reembolso-sin-pedido", orderCode, caseId: c.id };
    }
    await refundOrderPayment(payment.orderId, {
      source: "webhook",
      providerRef: providerRef ?? undefined,
      reason: "Reembolso notificado por el proveedor",
    });
    return { action: "refunded", orderCode: payment.order.code };
  }

  if (hintMatches(type, FAILED_HINTS)) {
    const payment = await findPayment(provider, providerRef, orderCode);
    if (!payment) {
      const c = await openCase({
        provider,
        detail: { kind: "pago-fallido-sin-pedido", eventId, orderCode, providerRef, amount },
        amount,
      });
      return { action: "case-pago-fallido-sin-pedido", orderCode, caseId: c.id };
    }
    await failOrderPayment(payment.orderId, { source: "webhook", reason: `webhook ${type}` });
    return { action: "failed", orderCode: payment.order.code };
  }

  if (hintMatches(type, APPROVED_HINTS)) {
    const payment = await findPayment(provider, providerRef, orderCode);
    if (!payment) {
      // P21: pago confirmado por la pasarela pero sin pedido interno.
      const c = await openCase({
        provider,
        detail: {
          kind: "pago-sin-pedido",
          eventId,
          orderCode,
          providerRef,
          amount,
          reason: "pago aprobado por el proveedor sin pedido ni pago interno que lo respalde; el cliente no se queda sin respuesta: emitir el boleto o reembolsar, con registro",
        },
        amount,
      });
      return { action: "case-pago-sin-pedido", orderCode, caseId: c.id };
    }
    try {
      await confirmOrderPayment(payment.orderId, {
        source: "webhook",
        reference: providerRef ?? eventId,
        amount: amount ?? undefined,
      });
    } catch (err) {
      // Monto distinto: el caso ya quedó abierto en confirmOrderPayment;
      // el evento se procesa (no se reintenta un parcial).
      if (err instanceof ApiError && err.code === "AMOUNT_MISMATCH") {
        return { action: "case-monto-distinto", orderCode: payment.order.code };
      }
      throw err;
    }
    return { action: "confirmed", orderCode: payment.order.code };
  }

  // Tipo desconocido: se registra y no se reintenta (sin efectos).
  return {
    action: "ignored-unknown-type",
    orderCode,
    error: `Tipo de evento no reconocido: ${type || "(vacío)"}`,
  };
}

/** Busca el pago por referencia del proveedor, o por código de pedido. */
async function findPayment(provider: ProviderCode, providerRef: string | null, orderCode: string | null) {
  if (providerRef) {
    const byRef = await db.payment.findFirst({
      where: { providerCode: provider, providerRef },
      include: { order: true },
    });
    if (byRef) return byRef;
  }
  if (orderCode) {
    const order = await db.order.findUnique({
      where: { code: orderCode.toUpperCase() },
      include: { payments: { orderBy: { createdAt: "desc" } } },
    });
    const payment = order?.payments[0];
    if (payment) return { ...payment, order };
  }
  return null;
}
