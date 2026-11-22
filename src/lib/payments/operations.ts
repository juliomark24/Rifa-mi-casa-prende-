// Operaciones de pago S5 (plan §2.2, §2.11, §2.12): confirmación de
// transferencia manual por el admin, reembolso y fallo de pago por
// webhook. Las tres son el ÚNICO camino para mover un pedido
// PENDIENTE → CONFIRMADO / REEMBOLSADO / FALLIDO con dinero de por
// medio, y las usan tanto las rutas admin como el procesador de
// webhooks (mismo código, mismo resultado).
//
// Reglas duras:
//  - Dinero en enteros; toda la secuencia de dinero va en UNA transacción
//    Prisma (pedido + pago + boletos + ledger + comisión).
//  - Idempotencia: confirmar un pedido ya CONFIRMADO (mismo reference) o
//    reembolsar uno ya REEMBOLSADO devuelve el estado actual sin duplicar
//    asientos, boletos ni comisiones. Un reference DISTINTO sobre un pedido
//    ya confirmado es 409 (no se re-confirma con otro comprobante).
//  - Nunca se confirma un pago parcial como venta completa (plan §2.11 y
//    nota de S4 en orders.ts): si el monto verificado difiere del total,
//    se abre un caso de conciliación ABIERTO y se rechaza con 409.
//  - Los pagos de pasarela (Azul/CardNet/PayPal) SOLO se confirman por
//    webhook verificado (`source: "webhook"`); un admin nunca confirma a
//    mano un cobro de tarjeta (eso saltaría la verificación del proveedor).
//  - Todo cambio de dinero deja asiento en ledger + AuditLog. La
//    notificación al comprador se encola DESPUÉS de la transacción con
//    queueNotificationSafe: si falla, la venta sigue (regla de oro §2.16).
//
// NOTA DE MODELO (PaymentStatus no tiene EXPIRADO): el job de expiración
// de S5 marca el Payment PENDIENTE como FALLIDO al expirar el pedido, la
// misma convención que `cancelOrder` de S4. Si el coordinador quiere un
// estado EXPIRADO en Payment, es cambio de schema (S1) a aprobar.
import { ApiError, conflict, notFound } from "../errors";
import { db, type Tx } from "../db";
import { logAudit } from "../audit";
import { appendLedgerEntry } from "../ledger";
import { presentOrder, type OrderView } from "../orders";
import { queueNotificationSafe } from "../notifications";
import {
  adjustCommissionsForRefund,
  createCommissionForOrder,
  type CommissionAdjustment,
} from "../affiliates";
import type { Payment } from "../../generated/prisma/client";

/** Boletos que pueden volver a venderse al reembolsar (rifa aún abierta). */
const RESELLABLE_RAFFLE_STATUSES = ["ACTIVA", "PAUSADA", "AGOTADA"] as const;

export type ConfirmPaymentInput = {
  actorId?: string | null;
  /** Referencia del comprobante (manual) o del proveedor (webhook). */
  reference: string;
  /** Referencia del comprobante de reembolso/transferencia (solo auditoría + ledger). */
  receiptRef?: string | null;
  /** Monto verificado. Si difiere del total del pedido → 409 + caso. */
  amount?: number;
  reason?: string | null;
  source: "admin" | "webhook";
};

export type ConfirmPaymentResult = {
  order: OrderView;
  tickets: Array<{ id: string; number: number; code: string; status: string }>;
  payment: { id: string; status: string; providerRef: string | null; amount: number; currency: string };
  commission: { id: string; amount: number; status: string } | null;
  alreadyConfirmed: boolean;
};

export type RefundPaymentInput = {
  actorId?: string | null;
  reason?: string | null;
  /** Referencia del reembolso en el proveedor (webhook de reembolso). */
  providerRef?: string | null;
  source: "admin" | "webhook";
};

export type RefundPaymentResult = {
  order: OrderView;
  tickets: Array<{ id: string; number: number; code: string; status: string }>;
  payment: { id: string; status: string; providerRef: string | null; amount: number; currency: string };
  commissionsAdjusted: CommissionAdjustment;
  alreadyRefunded: boolean;
  /** Boletos liberados para reventa (false = anulados, rifa ya cerrada/sorteada). */
  ticketsReleasedForResale: boolean;
};

type FullOrder = Awaited<ReturnType<typeof loadOrder>>;

async function loadOrder(orderId: string) {
  return db.order.findUnique({
    where: { id: orderId },
    include: {
      tickets: { orderBy: { number: "asc" } },
      payments: { orderBy: { createdAt: "desc" } },
      raffle: true,
      commissions: true,
    },
  });
}

function presentPayment(p: Payment) {
  return {
    id: p.id,
    status: p.status,
    providerRef: p.providerRef,
    amount: p.amount,
    currency: p.currency,
  };
}

function toResult(order: NonNullable<FullOrder>, alreadyConfirmed: boolean): ConfirmPaymentResult {
  const payment = order.payments[0];
  const commission = order.commissions[0] ?? null;
  return {
    order: presentOrder({ ...order, payments: order.payments.slice(0, 1) }),
    tickets: order.tickets.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
    payment: payment
      ? presentPayment(payment)
      : { id: "", status: "PENDIENTE", providerRef: null, amount: order.totalAmount, currency: order.currency },
    commission: commission
      ? { id: commission.id, amount: commission.amount, status: commission.status }
      : null,
    alreadyConfirmed,
  };
}

async function openReconciliationCase(input: {
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
 * Confirma un pago: Payment PENDIENTE → APROBADO, Order PENDIENTE →
 * CONFIRMADO, tickets RESERVADO → VENDIDO, asiento VENTA en ledger y
 * comisión PENDIENTE del 10% si hay afiliado. Idempotente (ver cabecera).
 */
export async function confirmOrderPayment(
  orderId: string,
  input: ConfirmPaymentInput,
): Promise<ConfirmPaymentResult> {
  const order = await loadOrder(orderId);
  if (!order) throw notFound("Pedido no existe");
  const payment = order.payments[0];
  const reference = input.reference.trim();
  if (!reference) throw new ApiError(400, "La referencia del pago es obligatoria", "VALIDATION_ERROR");

  // Replay idempotente: ya confirmado con la misma referencia.
  if (order.status === "CONFIRMADO" && payment?.status === "APROBADO") {
    if (payment.providerRef && payment.providerRef !== reference) {
      throw conflict(
        `El pedido ya fue confirmado con otra referencia (${payment.providerRef}); no se puede re-confirmar`,
        "REFERENCE_MISMATCH",
      );
    }
    return toResult(order, true);
  }
  if (order.status !== "PENDIENTE") {
    throw conflict(`Solo se puede confirmar un pedido PENDIENTE (actual: ${order.status})`, "ORDER_NOT_CONFIRMABLE");
  }
  if (!payment || payment.status !== "PENDIENTE") {
    throw conflict(
      `El pago no está pendiente (actual: ${payment?.status ?? "sin pago"})`,
      "PAYMENT_NOT_PENDING",
    );
  }
  if (payment.providerCode !== "MANUAL_TRANSFER" && input.source !== "webhook") {
    throw conflict(
      `Los pagos de ${payment.providerCode} solo se confirman por webhook verificado del proveedor`,
      "REQUIRES_WEBHOOK",
    );
  }
  if (input.amount !== undefined) {
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      throw new ApiError(400, "El monto debe ser un entero no negativo", "VALIDATION_ERROR");
    }
    if (input.amount !== order.totalAmount) {
      await openReconciliationCase({
        provider: payment.providerCode ?? "MANUAL_TRANSFER",
        detail: {
          kind: "monto-distinto",
          orderId: order.id,
          orderCode: order.code,
          expectedAmount: order.totalAmount,
          receivedAmount: input.amount,
          reference,
          source: input.source,
          reason: "el monto verificado difiere del total del pedido; nunca se confirma un parcial como venta completa",
        },
        amount: input.amount,
        currency: order.currency,
      });
      throw conflict(
        `El monto verificado (${input.amount}) difiere del total del pedido (${order.totalAmount}); se abrió un caso de conciliación para revisión humana`,
        "AMOUNT_MISMATCH",
      );
    }
  }

  const commissionRateNote = "10% por defecto (Setting COMMISSION_RATE o env)";
  const confirmed = await db.$transaction(async (tx: Tx) => {
    // Guardia dentro de la transacción (carrera entre dos confirmaciones).
    const fresh = await tx.order.findUnique({
      where: { id: orderId },
      include: { tickets: true, payments: { orderBy: { createdAt: "desc" } }, commissions: true },
    });
    if (!fresh) throw notFound("Pedido no existe");
    if (fresh.status === "CONFIRMADO") return { replay: true as const, order: fresh };
    if (fresh.status !== "PENDIENTE") {
      throw conflict(`Solo se puede confirmar un pedido PENDIENTE (actual: ${fresh.status})`, "ORDER_NOT_CONFIRMABLE");
    }
    await tx.order.update({ where: { id: orderId }, data: { status: "CONFIRMADO" } });
    await tx.payment.updateMany({
      where: { orderId, status: "PENDIENTE" },
      data: { status: "APROBADO", providerRef: reference },
    });
    await tx.ticket.updateMany({
      where: { orderId, status: "RESERVADO" },
      data: { status: "VENDIDO" },
    });
    await appendLedgerEntry(tx, {
      type: "VENTA",
      amount: order.totalAmount,
      currency: order.currency,
      refType: "Order",
      refId: order.id,
      metadata: {
        orderCode: order.code,
        paymentId: payment.id,
        providerCode: payment.providerCode,
        reference,
        receiptRef: input.receiptRef ?? null,
        source: input.source,
      },
    });
    const commission = await createCommissionForOrder(tx, order);
    return { replay: false as const, order: fresh, commission };
  });

  if (confirmed.replay) {
    const reloaded = await loadOrder(orderId);
    if (!reloaded) throw notFound("Pedido no existe");
    return toResult(reloaded, true);
  }

  const full = await loadOrder(orderId);
  if (!full) throw notFound("Pedido no existe");
  const result = toResult(full, false);

  await logAudit({
    actorId: input.actorId ?? null,
    action: "orders.confirm",
    entity: "Order",
    entityId: orderId,
    before: { status: "PENDIENTE", paymentStatus: "PENDIENTE", tickets: order.tickets.map((t) => t.number) },
    after: {
      status: "CONFIRMADO",
      paymentStatus: "APROBADO",
      reference,
      receiptRef: input.receiptRef ?? null,
      source: input.source,
      commission: result.commission ? { id: result.commission.id, amount: result.commission.amount, note: commissionRateNote } : null,
      reason: input.reason ?? null,
    },
  });
  await queueNotificationSafe({
    event: "pago_confirmado",
    channel: "EMAIL",
    recipient: order.buyerEmail,
    data: {
      buyerName: order.buyerName,
      orderCode: order.code,
      totalAmount: order.totalAmount,
      currency: order.currency,
    },
    dedupeKey: `pago:${order.code}`,
  });
  if (result.commission && order.affiliateId) {
    const affiliate = await db.user.findUnique({ where: { id: order.affiliateId } });
    if (affiliate) {
      await queueNotificationSafe({
        event: "comision_afiliada",
        channel: "EMAIL",
        recipient: affiliate.email,
        data: {
          affiliateName: affiliate.name,
          orderCode: order.code,
          totalAmount: result.commission.amount,
          currency: order.currency,
        },
        dedupeKey: `comision:${order.code}`,
      });
    }
  }
  return result;
}

/**
 * Reembolsa un pedido CONFIRMADO (plan §2.3, §2.4, P6): Payment
 * APROBADO → REEMBOLSADO, Order CONFIRMADO → REEMBOLSADO, boletos
 * VENDIDO → DISPONIBLE (rifa aún abierta, para reventa) o ANULADO (rifa
 * cerrada/sorteada: el número no vuelve a venderse), asiento REEMBOLSO
 * compensatorio en ledger (nunca se borra la VENTA) y ajuste de
 * comisiones vía `adjustCommissionsForRefund` (S6: retención/retiros).
 * Un pedido PENDIENTE no se reembolsa (400: no hay cobro que devolver).
 * Idempotente: reembolsar dos veces devuelve el estado sin duplicar.
 */
export async function refundOrderPayment(
  orderId: string,
  input: RefundPaymentInput,
): Promise<RefundPaymentResult> {
  const order = await loadOrder(orderId);
  if (!order) throw notFound("Pedido no existe");
  const payment = order.payments[0];

  if (order.status === "REEMBOLSADO" && payment?.status === "REEMBOLSADO") {
    return {
      order: presentOrder({ ...order, payments: order.payments.slice(0, 1) }),
      tickets: order.tickets.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
      payment: presentPayment(payment),
      commissionsAdjusted: { adjusted: [], pendingHumanReview: [] },
      alreadyRefunded: true,
      ticketsReleasedForResale: false,
    };
  }
  if (order.status === "PENDIENTE") {
    throw new ApiError(
      400,
      "El pedido está PENDIENTE: no hay cobro confirmado que devolver (usa cancelar si no se va a cobrar)",
      "REFUND_NOTHING_TO_REFUND",
    );
  }
  if (order.status !== "CONFIRMADO") {
    throw conflict(`Solo se puede reembolsar un pedido CONFIRMADO (actual: ${order.status})`, "ORDER_NOT_REFUNDABLE");
  }
  if (!payment || payment.status !== "APROBADO") {
    throw conflict(`El pago no está aprobado (actual: ${payment?.status ?? "sin pago"})`, "PAYMENT_NOT_APPROVED");
  }

  const releaseForResale = (RESELLABLE_RAFFLE_STATUSES as readonly string[]).includes(order.raffle.status);
  const ticketTarget = releaseForResale ? "DISPONIBLE" : "ANULADO";

  const refunded = await db.$transaction(async (tx: Tx) => {
    const fresh = await tx.order.findUnique({
      where: { id: orderId },
      include: { tickets: true, payments: { orderBy: { createdAt: "desc" } } },
    });
    if (!fresh) throw notFound("Pedido no existe");
    if (fresh.status === "REEMBOLSADO") return { replay: true as const };
    if (fresh.status !== "CONFIRMADO") {
      throw conflict(`Solo se puede reembolsar un pedido CONFIRMADO (actual: ${fresh.status})`, "ORDER_NOT_REFUNDABLE");
    }
    await tx.order.update({ where: { id: orderId }, data: { status: "REEMBOLSADO" } });
    await tx.payment.updateMany({
      where: { orderId, status: "APROBADO" },
      data: { status: "REEMBOLSADO", ...(input.providerRef ? { providerRef: input.providerRef } : {}) },
    });
    await tx.ticket.updateMany({
      where: { orderId, status: "VENDIDO" },
      data: { status: ticketTarget, orderId: null, reservationId: null },
    });
    await appendLedgerEntry(tx, {
      type: "REEMBOLSO",
      amount: -order.totalAmount,
      currency: order.currency,
      refType: "Order",
      refId: order.id,
      metadata: {
        orderCode: order.code,
        paymentId: payment.id,
        providerCode: payment.providerCode,
        reason: input.reason ?? null,
        source: input.source,
        providerRef: input.providerRef ?? payment.providerRef,
      },
    });
    const commissionsAdjusted = await adjustCommissionsForRefund(tx, order, {
      reason: input.reason ?? "reembolso del pedido",
    });
    return { replay: false as const, commissionsAdjusted };
  });

  if (refunded.replay) {
    const reloaded = await loadOrder(orderId);
    if (!reloaded || !reloaded.payments[0]) throw notFound("Pedido no existe");
    return {
      order: presentOrder({ ...reloaded, payments: reloaded.payments.slice(0, 1) }),
      tickets: reloaded.tickets.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
      payment: presentPayment(reloaded.payments[0]),
      commissionsAdjusted: { adjusted: [], pendingHumanReview: [] },
      alreadyRefunded: true,
      ticketsReleasedForResale: false,
    };
  }

  // Comisiones ya liberadas/pagadas: S6 las compensa como saldo negativo;
  // S5 deja el caso abierto para revisión humana (nunca en silencio).
  if (refunded.commissionsAdjusted.pendingHumanReview.length > 0) {
    await openReconciliationCase({
      provider: payment.providerCode ?? "MANUAL_TRANSFER",
      detail: {
        kind: "comision-pagada-reembolsada",
        orderId: order.id,
        orderCode: order.code,
        commissions: refunded.commissionsAdjusted.pendingHumanReview,
        reason: "el pedido se reembolsó pero su comisión ya estaba liberada/pagada; S6 debe compensarla como saldo negativo",
      },
      amount: order.totalAmount,
      currency: order.currency,
    });
  }

  const full = await loadOrder(orderId);
  if (!full || !full.payments[0]) throw notFound("Pedido no existe");
  await logAudit({
    actorId: input.actorId ?? null,
    action: "orders.refund",
    entity: "Order",
    entityId: orderId,
    before: { status: "CONFIRMADO", paymentStatus: "APROBADO", tickets: order.tickets.map((t) => t.number) },
    after: {
      status: "REEMBOLSADO",
      paymentStatus: "REEMBOLSADO",
      ticketsTarget: ticketTarget,
      reason: input.reason ?? null,
      source: input.source,
      commissionsAdjusted: refunded.commissionsAdjusted.adjusted,
      commissionsPendingReview: refunded.commissionsAdjusted.pendingHumanReview,
    },
  });
  await queueNotificationSafe({
    event: "reembolso",
    channel: "EMAIL",
    recipient: order.buyerEmail,
    data: {
      buyerName: order.buyerName,
      orderCode: order.code,
      totalAmount: order.totalAmount,
      currency: order.currency,
    },
    dedupeKey: `reembolso:${order.code}`,
  });
  return {
    order: presentOrder({ ...full, payments: full.payments.slice(0, 1) }),
    tickets: full.tickets.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
    payment: presentPayment(full.payments[0]),
    commissionsAdjusted: refunded.commissionsAdjusted,
    alreadyRefunded: false,
    ticketsReleasedForResale: releaseForResale,
  };
}

export type ChargebackInput = {
  actorId?: string | null;
  /** Referencia del contracargo en el proveedor (webhook). */
  providerRef?: string | null;
  reason?: string | null;
  source: "admin" | "webhook";
};

export type ChargebackResult = {
  order: OrderView;
  payment: { id: string; status: string; providerRef: string | null; amount: number; currency: string } | null;
  commissionsAdjusted: CommissionAdjustment;
  /** true si se movió dinero (Payment → CONTRACARGO + asiento). */
  moved: boolean;
  /** true si el pago ya estaba en CONTRACARGO (replay idempotente). */
  alreadyChargedBack: boolean;
  /** Motivo cuando no se movió dinero (p. ej. pago no aprobado). */
  reason?: string;
};

/**
 * Aplica un contracargo (S9-int, plan §2.2, §2.4): Payment APROBADO →
 * CONTRACARGO, Order CONFIRMADO → DISPUTADO, asiento CONTRACARGO
 * compensatorio en ledger (nunca se borra la VENTA) y ajuste de
 * comisiones vía `adjustCommissionsForRefund` (S6). Todo en UNA
 * transacción Prisma + AuditLog. Idempotente: un segundo contracargo
 * sobre el mismo pago devuelve el estado sin duplicar asientos,
 * boletos ni comisiones.
 *
 * Decisiones documentadas:
 *  - Solo se mueve dinero si el pago estaba APROBADO. Un pago PENDIENTE,
 *    FALLIDO o REEMBOLSADO no tiene cobro que devolver: se devuelve
 *    moved:false sin error (el caso de fraude igual queda registrado por
 *    `handleChargeback`).
 *  - Los boletos NO se tocan (siguen VENDIDO): el contracargo es una
 *    disputa de pago, no una cancelación; su anulación es decisión humana
 *    desde el caso de fraude / bloqueo de boletos.
 *  - Comisiones AVAILABLE/PAID que el reembolso dejaría en revisión
 *    humana abren el mismo caso `comision-pagada-reembolsada` que S5,
 *    para que el job `compensate-paid-commissions` (S6) las compense
 *    igual (el caso indica en el detalle que el origen es contracargo).
 */
export async function applyChargeback(
  orderId: string,
  input: ChargebackInput,
): Promise<ChargebackResult> {
  const order = await loadOrder(orderId);
  if (!order) throw notFound("Pedido no existe");
  const payment = order.payments[0] ?? null;

  const current: ChargebackResult = {
    order: presentOrder({ ...order, payments: order.payments.slice(0, 1) }),
    payment: payment ? presentPayment(payment) : null,
    commissionsAdjusted: { adjusted: [], pendingHumanReview: [] },
    moved: false,
    alreadyChargedBack: payment?.status === "CONTRACARGO",
  };
  if (payment?.status === "CONTRACARGO") return current;
  if (!payment || payment.status !== "APROBADO") {
    return {
      ...current,
      reason: `El pago no está aprobado (actual: ${payment?.status ?? "sin pago"}); no hay cobro que devolver por contracargo`,
    };
  }
  if (order.status !== "CONFIRMADO" && order.status !== "DISPUTADO") {
    throw conflict(
      `Solo se puede aplicar un contracargo a un pedido CONFIRMADO o DISPUTADO (actual: ${order.status})`,
      "ORDER_NOT_CHARGEBACKABLE",
    );
  }

  const chargedBack = await db.$transaction(async (tx: Tx) => {
    const fresh = await tx.order.findUnique({
      where: { id: orderId },
      include: { payments: { orderBy: { createdAt: "desc" } } },
    });
    if (!fresh) throw notFound("Pedido no existe");
    if (fresh.payments[0]?.status === "CONTRACARGO") return { replay: true as const };
    if (fresh.payments[0]?.status !== "APROBADO") {
      throw conflict(
        `El pago ya no está aprobado (actual: ${fresh.payments[0]?.status ?? "sin pago"})`,
        "PAYMENT_NOT_APPROVED",
      );
    }
    if (fresh.status === "CONFIRMADO") {
      await tx.order.update({ where: { id: orderId }, data: { status: "DISPUTADO" } });
    }
    await tx.payment.updateMany({
      where: { orderId, status: "APROBADO" },
      data: { status: "CONTRACARGO", ...(input.providerRef ? { providerRef: input.providerRef } : {}) },
    });
    await appendLedgerEntry(tx, {
      type: "CONTRACARGO",
      amount: -order.totalAmount,
      currency: order.currency,
      refType: "Order",
      refId: order.id,
      metadata: {
        orderCode: order.code,
        paymentId: payment.id,
        providerCode: payment.providerCode,
        reason: input.reason ?? null,
        source: input.source,
        providerRef: input.providerRef ?? payment.providerRef,
      },
    });
    const commissionsAdjusted = await adjustCommissionsForRefund(tx, order, {
      reason: input.reason ?? "contracargo del pedido",
    });
    return { replay: false as const, commissionsAdjusted };
  });

  if (chargedBack.replay) {
    const reloaded = await loadOrder(orderId);
    if (!reloaded) throw notFound("Pedido no existe");
    return {
      ...current,
      order: presentOrder({ ...reloaded, payments: reloaded.payments.slice(0, 1) }),
      payment: reloaded.payments[0] ? presentPayment(reloaded.payments[0]) : null,
      alreadyChargedBack: true,
    };
  }

  // Comisiones ya liberadas/pagadas: S6 las compensa como saldo negativo;
  // se deja el mismo caso que en el reembolso para que el job las resuelva.
  if (chargedBack.commissionsAdjusted.pendingHumanReview.length > 0) {
    await openReconciliationCase({
      provider: payment.providerCode ?? "MANUAL_TRANSFER",
      detail: {
        kind: "comision-pagada-reembolsada",
        origin: "contracargo",
        orderId: order.id,
        orderCode: order.code,
        commissions: chargedBack.commissionsAdjusted.pendingHumanReview,
        reason: "el pedido entró en contracargo pero su comisión ya estaba liberada/pagada; S6 debe compensarla como saldo negativo",
      },
      amount: order.totalAmount,
      currency: order.currency,
    });
  }

  const full = await loadOrder(orderId);
  if (!full || !full.payments[0]) throw notFound("Pedido no existe");
  await logAudit({
    actorId: input.actorId ?? null,
    action: "orders.chargeback",
    entity: "Order",
    entityId: orderId,
    before: { status: order.status, paymentStatus: "APROBADO", tickets: order.tickets.map((t) => t.number) },
    after: {
      status: "DISPUTADO",
      paymentStatus: "CONTRACARGO",
      reason: input.reason ?? null,
      source: input.source,
      commissionsAdjusted: chargedBack.commissionsAdjusted.adjusted,
      commissionsPendingReview: chargedBack.commissionsAdjusted.pendingHumanReview,
    },
  });
  return {
    order: presentOrder({ ...full, payments: full.payments.slice(0, 1) }),
    payment: presentPayment(full.payments[0]),
    commissionsAdjusted: chargedBack.commissionsAdjusted,
    moved: true,
    alreadyChargedBack: false,
  };
}

/**
 * Marca fallido un pago PENDIENTE (webhook de denegación del proveedor,
 * P3): Order → FALLIDO, Payment → FALLIDO, boletos RESERVADO →
 * DISPONIBLE. Sin boleto vendido ni comisión. Idempotente.
 */
export async function failOrderPayment(
  orderId: string,
  input: { reason?: string | null; source: "webhook" | "admin" },
): Promise<{ order: OrderView; alreadyFailed: boolean }> {
  const order = await loadOrder(orderId);
  if (!order) throw notFound("Pedido no existe");
  if (order.status === "FALLIDO") {
    return {
      order: presentOrder({ ...order, payments: order.payments.slice(0, 1) }),
      alreadyFailed: true,
    };
  }
  if (order.status !== "PENDIENTE") {
    throw conflict(`Solo se puede marcar fallido un pedido PENDIENTE (actual: ${order.status})`, "ORDER_NOT_FAILABLE");
  }
  const reservationIds = [
    ...new Set(order.tickets.map((t) => t.reservationId).filter((x): x is string => Boolean(x))),
  ];
  await db.$transaction(async (tx: Tx) => {
    const fresh = await tx.order.findUnique({ where: { id: orderId } });
    if (!fresh || fresh.status !== "PENDIENTE") return;
    await tx.order.update({ where: { id: orderId }, data: { status: "FALLIDO" } });
    await tx.payment.updateMany({ where: { orderId, status: "PENDIENTE" }, data: { status: "FALLIDO" } });
    await tx.ticket.updateMany({
      where: { orderId, status: "RESERVADO" },
      data: { status: "DISPONIBLE", orderId: null, reservationId: null },
    });
    for (const rid of reservationIds) {
      await tx.reservation.updateMany({ where: { id: rid, status: "CONFIRMADA" }, data: { status: "CANCELADA" } });
    }
  });
  await logAudit({
    actorId: null,
    action: "orders.payment-failed",
    entity: "Order",
    entityId: orderId,
    before: { status: "PENDIENTE" },
    after: { status: "FALLIDO", reason: input.reason ?? null, source: input.source },
  });
  const full = await loadOrder(orderId);
  if (!full) throw notFound("Pedido no existe");
  return {
    order: presentOrder({ ...full, payments: full.payments.slice(0, 1) }),
    alreadyFailed: false,
  };
}
