// Prevención de fraude (plan §2.14, §2.18; P22).
//
// Módulo configurable de detección (no bloqueo automático total en v1):
// lo sospechoso se marca para revisión humana y queda registrado; la
// revisión humana es obligatoria antes de bloquear o retener de forma
// definitiva. Estados de riesgo: Normal → Revisión → Retenido →
// Aprobado / Bloqueado (RiskStatus del schema; "Normal" = sin caso
// abierto).
//
// REGLAS (umbrales configurables por Setting, con env y defecto):
//  - velocity-purchase: muchos pedidos (o boletos) del mismo comprador
//    (email/teléfono/IP) en poco tiempo. Defecto: ≥5 pedidos o ≥20
//    boletos en 60 minutos.
//  - self-referral-attempt: un afiliado intenta generar comisión con sus
//    propias compras (mismo usuario, email o teléfono). S4 ya lo bloquea
//    en la compra; aquí se DETECTAN los intentos que llegan al sistema.
//  - duplicate-accounts: varias cuentas con el mismo teléfono (el email
//    es único en el schema, así que el duplicado por email se detecta en
//    pedidos de invitados con mismo email y distinto nombre/teléfono).
//  - repeated-refunds: reembolsos repetidos del mismo comprador.
//    Defecto: ≥2 en 90 días.
//  - chargeback: contracargo notificado por el proveedor (S5 solo abre
//    caso de conciliación; aquí se marca pedido/afiliado en Revisión y
//    se abre el caso de fraude). Defecto: 1 contracargo ya marca.
//  - repeated-chargebacks: contracargos recurrentes del mismo comprador
//    o afiliado.
//
// ACCIONES: marcar para revisión (FraudCase REVISION), retener
// comisión (AVAILABLE → RETAINED), bloquear afiliado/comprador
// (FraudCase BLOQUEADO + auditoría). El bloqueo se HACE EFECTIVO en:
//  - retiros: approve/request rechazan si hay caso REVISION/RETENIDO/
//    BLOQUEADO abierto del afiliado (ver affiliates.ts).
//  - compras: `isBlockedFromPurchasing` (S9-int) bloquea la compra en
//    `createOrder` (orders.ts) si comprador, cuenta o afiliado están
//    BLOQUEADOS (403 con motivo).
//
// CONTRACARGO (S9-int): `handleChargeback` llama a `applyChargeback`
// (operations.ts, único camino para mover dinero): Payment APROBADO →
// CONTRACARGO + asiento CONTRACARGO en ledger + ajuste de comisiones.
// Los boletos no se tocan (su anulación es decisión humana).
//
// Umbrales (Setting → env → defecto):
//  FRAUD_VELOCITY_MAX_ORDERS=5, FRAUD_VELOCITY_WINDOW_MINUTES=60,
//  FRAUD_VELOCITY_MAX_TICKETS=20, FRAUD_MAX_REFUNDS=2,
//  FRAUD_REFUND_WINDOW_DAYS=90, FRAUD_MAX_CHARGEBACKS=1.
import { db, type Tx } from "./db";
import { logAudit } from "./audit";
import { getSettingInt } from "./affiliates";
import { notFound } from "./errors";

type Client = typeof db | Tx;

export const FRAUD_RULES = {
  VELOCITY: "velocity-purchase",
  SELF_REFERRAL: "self-referral-attempt",
  DUPLICATE_ACCOUNTS: "duplicate-accounts",
  REPEATED_REFUNDS: "repeated-refunds",
  CHARGEBACK: "chargeback",
  REPEATED_CHARGEBACKS: "repeated-chargebacks",
} as const;

export type FraudThresholds = {
  velocityMaxOrders: number;
  velocityWindowMinutes: number;
  velocityMaxTickets: number;
  maxRefunds: number;
  refundWindowDays: number;
  maxChargebacks: number;
};

export async function getFraudThresholds(): Promise<FraudThresholds> {
  const [velocityMaxOrders, velocityWindowMinutes, velocityMaxTickets, maxRefunds, refundWindowDays, maxChargebacks] =
    await Promise.all([
      getSettingInt("FRAUD_VELOCITY_MAX_ORDERS", "FRAUD_VELOCITY_MAX_ORDERS", 5),
      getSettingInt("FRAUD_VELOCITY_WINDOW_MINUTES", "FRAUD_VELOCITY_WINDOW_MINUTES", 60),
      getSettingInt("FRAUD_VELOCITY_MAX_TICKETS", "FRAUD_VELOCITY_MAX_TICKETS", 20),
      getSettingInt("FRAUD_MAX_REFUNDS", "FRAUD_MAX_REFUNDS", 2),
      getSettingInt("FRAUD_REFUND_WINDOW_DAYS", "FRAUD_REFUND_WINDOW_DAYS", 90),
      getSettingInt("FRAUD_MAX_CHARGEBACKS", "FRAUD_MAX_CHARGEBACKS", 1),
    ]);
  return { velocityMaxOrders, velocityWindowMinutes, velocityMaxTickets, maxRefunds, refundWindowDays, maxChargebacks };
}

/** Riesgo actual de un usuario (peor caso abierto; NORMAL si no hay). */
export async function getRiskStatusForUser(client: Client, userId: string): Promise<string> {
  const c = await client.fraudCase.findFirst({
    where: {
      entityType: "User",
      entityId: userId,
      status: { in: ["REVISION", "RETENIDO", "BLOQUEADO"] },
    },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  return c?.status ?? "NORMAL";
}

export type PurchaseBlockCheck = {
  buyerEmail?: string | null;
  userId?: string | null;
  affiliateId?: string | null;
};

/**
 * Bloqueo de compras por fraude (S9-int, plan §2.14): un comprador o un
 * afiliado BLOQUEADO no puede comprar. Se consulta en `createOrder`
 * (orders.ts) ANTES de crear el pedido. Un caso BLOQUEADO bloquea aunque
 * esté cerrado (resolvedAt): BLOQUEADO es el estado, no la apertura del
 * caso; solo una revisión humana que lo reabra (→ REVISION) y luego lo
 * apruebe (→ APROBADO) levanta el bloqueo.
 *
 * Entidades consultadas:
 *  - Buyer: caso con entityType "Buyer" y entityId = email del comprador.
 *  - User: caso con entityType "User" y entityId = id de la cuenta.
 *  - Afiliado: caso con entityType "User" y entityId = id del afiliado
 *    atribuido a la compra (su propio bloqueo también bloquea la venta).
 */
export async function isBlockedFromPurchasing(
  client: Client,
  input: PurchaseBlockCheck,
): Promise<{ blocked: boolean; reason?: string; caseId?: string }> {
  const ors: Array<Record<string, unknown>> = [];
  if (input.buyerEmail) {
    ors.push({ entityType: "Buyer", entityId: input.buyerEmail.trim().toLowerCase() });
  }
  if (input.userId) {
    ors.push({ entityType: "User", entityId: input.userId });
  }
  if (input.affiliateId) {
    ors.push({ entityType: "User", entityId: input.affiliateId });
  }
  if (ors.length === 0) return { blocked: false };
  const c = await client.fraudCase.findFirst({
    where: { status: "BLOQUEADO", OR: ors },
    orderBy: { createdAt: "desc" },
    select: { id: true, entityType: true, rule: true, reason: true },
  });
  if (!c) return { blocked: false };
  const who =
    c.entityType === "Buyer"
      ? `el comprador ${input.buyerEmail}`
      : c.entityType === "User" && input.affiliateId && c.id
        ? "el comprador o su afiliado"
        : "la cuenta";
  return {
    blocked: true,
    caseId: c.id,
    reason: `Compra bloqueada por fraude: ${who} está BLOQUEADO (regla ${c.rule}: ${c.reason}). Revisión humana obligatoria en el panel de fraude.`,
  };
}

// ---------------------------------------------------------------- marcar
export type FlagForReviewInput = {
  rule: string;
  reason: string;
  entityType: string; // Order | User | Withdrawal | Buyer
  entityId: string;
  actorId?: string | null;
};

/**
 * Marca una entidad para revisión (crea FraudCase REVISION). Idempotente:
 * si ya hay un caso ABIERTO (REVISION/RETENIDO) con misma regla y
 * entidad, devuelve ese caso sin duplicar. Nunca borra registros.
 */
export async function flagForReview(
  client: Client,
  input: FlagForReviewInput,
) {
  const existing = await client.fraudCase.findFirst({
    where: {
      rule: input.rule,
      entityType: input.entityType,
      entityId: input.entityId,
      status: { in: ["REVISION", "RETENIDO"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return { fraudCase: existing, created: false };
  const fraudCase = await client.fraudCase.create({
    data: {
      rule: input.rule,
      reason: input.reason,
      status: "REVISION",
      entityType: input.entityType,
      entityId: input.entityId,
    },
  });
  await logAudit({
    actorId: input.actorId ?? null,
    action: "fraud.case.flagged",
    entity: "FraudCase",
    entityId: fraudCase.id,
    after: { rule: input.rule, entityType: input.entityType, entityId: input.entityId, reason: input.reason },
  });
  return { fraudCase, created: true };
}

// ---------------------------------------------------------------- reglas
export type VelocityInput = {
  buyerEmail?: string | null;
  buyerPhone?: string | null;
  /** IP del comprador (no se guarda en Order; se pasa desde la ruta/job). */
  ipAddress?: string | null;
  now?: Date;
};

export type VelocityResult = {
  flagged: boolean;
  orders: number;
  tickets: number;
  reason?: string;
};

/**
 * Regla de velocidad: pedidos/boletos del mismo comprador en la ventana.
 * Cuenta pedidos PENDIENTE/CONFIRMADO creados en la ventana (un pedido
 * con muchos boletos también cuenta por boletos). Sin identificadores no
 * se puede evaluar (flagged=false).
 */
export async function checkPurchaseVelocity(
  client: Client,
  input: VelocityInput,
  thresholds?: FraudThresholds,
): Promise<VelocityResult> {
  const t = thresholds ?? (await getFraudThresholds());
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - t.velocityWindowMinutes * 60 * 1000);
  const ors: Array<Record<string, unknown>> = [];
  if (input.buyerEmail) ors.push({ buyerEmail: input.buyerEmail.trim().toLowerCase() });
  if (input.buyerPhone) ors.push({ buyerPhone: input.buyerPhone.trim() });
  if (ors.length === 0) return { flagged: false, orders: 0, tickets: 0 };
  const orders = await client.order.findMany({
    where: {
      OR: ors,
      createdAt: { gte: since },
      status: { in: ["PENDIENTE", "CONFIRMADO"] },
    },
    include: { _count: { select: { tickets: true } } },
  });
  const tickets = orders.reduce((acc, o) => acc + o._count.tickets, 0);
  if (orders.length >= t.velocityMaxOrders || tickets >= t.velocityMaxTickets) {
    return {
      flagged: true,
      orders: orders.length,
      tickets,
      reason: `${orders.length} pedidos (${tickets} boletos) en ${t.velocityWindowMinutes} min (máx ${t.velocityMaxOrders} pedidos / ${t.velocityMaxTickets} boletos)`,
    };
  }
  return { flagged: false, orders: orders.length, tickets };
}

export type SelfReferralInput = {
  orderId: string;
  affiliateId?: string | null;
  buyerEmail?: string | null;
  userId?: string | null;
  buyerPhone?: string | null;
};

/**
 * Detección de auto-referido: el comprador ES el afiliado (mismo userId,
 * mismo email o mismo teléfono que el afiliado). S4 lo bloquea en la
 * compra; esto detecta intentos que llegaron al sistema (p. ej. pedidos
 * creados por otra vía) y abre el caso. Devuelve null si no hay afiliado
 * o no hay coincidencia.
 */
export async function detectSelfReferralAttempt(
  client: Client,
  input: SelfReferralInput,
) {
  if (!input.affiliateId) return null;
  const affiliate = await client.user.findUnique({ where: { id: input.affiliateId } });
  if (!affiliate) return null;
  const emailMatch =
    !!input.buyerEmail && affiliate.email.trim().toLowerCase() === input.buyerEmail.trim().toLowerCase();
  const userMatch = !!input.userId && input.userId === affiliate.id;
  const phoneMatch =
    !!input.buyerPhone && !!affiliate.phone && affiliate.phone.trim() === input.buyerPhone.trim();
  if (!emailMatch && !userMatch && !phoneMatch) return null;
  const reason = `Auto-referido: el comprador coincide con el afiliado ${affiliate.referralCode ?? affiliate.id} (${[
    emailMatch ? "mismo email" : "",
    userMatch ? "misma cuenta" : "",
    phoneMatch ? "mismo teléfono" : "",
  ]
    .filter(Boolean)
    .join(", ")})`;
  return flagForReview(client, {
    rule: FRAUD_RULES.SELF_REFERRAL,
    reason,
    entityType: "Order",
    entityId: input.orderId,
  });
}

/**
 * Detección de múltiples cuentas con los mismos datos: otros usuarios
 * con el mismo teléfono, o pedidos de invitados con el mismo email y
 * distinto nombre. El email de usuario es único en el schema, así que
 * el duplicado por email vive en los pedidos (compra invitada).
 */
export async function detectDuplicateAccounts(
  client: Client,
  input: { userId?: string | null; phone?: string | null; buyerEmail?: string | null; buyerName?: string | null },
) {
  const findings: string[] = [];
  if (input.phone) {
    const others = await client.user.findMany({
      where: { phone: input.phone.trim(), ...(input.userId ? { id: { not: input.userId } } : {}) },
      select: { id: true, email: true },
    });
    if (others.length > 0) {
      findings.push(`${others.length + 1} cuentas con el teléfono ${input.phone}`);
    }
  }
  if (input.buyerEmail && input.buyerName) {
    const others = await client.order.findMany({
      where: {
        buyerEmail: input.buyerEmail.trim().toLowerCase(),
        buyerName: { not: input.buyerName },
      },
      select: { id: true },
      take: 1,
    });
    if (others.length > 0) {
      findings.push(`pedidos con el email ${input.buyerEmail} a nombre distinto`);
    }
  }
  if (findings.length === 0) return null;
  const entityId = input.userId ?? input.buyerEmail ?? "unknown";
  return flagForReview(client, {
    rule: FRAUD_RULES.DUPLICATE_ACCOUNTS,
    reason: `Múltiples cuentas con los mismos datos: ${findings.join("; ")}`,
    entityType: input.userId ? "User" : "Buyer",
    entityId,
  });
}

export type RepeatedRefundsResult = { flagged: boolean; refunds: number; chargebacks: number; reason?: string };

/**
 * Reembolsos/contracargos repetidos del mismo comprador (por email).
 * ≥ maxRefunds reembolsos en la ventana, o ≥ maxChargebacks contracargos,
 * marcan para revisión.
 */
export async function detectRepeatedRefunds(
  client: Client,
  buyerEmail: string,
  thresholds?: FraudThresholds,
  now: Date = new Date(),
): Promise<RepeatedRefundsResult> {
  const t = thresholds ?? (await getFraudThresholds());
  const since = new Date(now.getTime() - t.refundWindowDays * 24 * 60 * 60 * 1000);
  const email = buyerEmail.trim().toLowerCase();
  const [refunds, chargebacks] = await Promise.all([
    client.order.count({ where: { buyerEmail: email, status: "REEMBOLSADO", updatedAt: { gte: since } } }),
    client.payment.count({
      where: { status: "CONTRACARGO", order: { buyerEmail: email }, updatedAt: { gte: since } },
    }),
  ]);
  if (chargebacks >= t.maxChargebacks) {
    return { flagged: true, refunds, chargebacks, reason: `${chargebacks} contracargo(s) en ${t.refundWindowDays} días` };
  }
  if (refunds >= t.maxRefunds) {
    return { flagged: true, refunds, chargebacks, reason: `${refunds} reembolsos en ${t.refundWindowDays} días (máx ${t.maxRefunds})` };
  }
  return { flagged: false, refunds, chargebacks };
}

// ---------------------------------------------------------------- revisión y acciones
const FINAL_RISK_STATUSES = ["APROBADO", "BLOQUEADO"] as const;

export type ReviewFraudCaseInput = {
  riskStatus: "NORMAL" | "REVISION" | "RETENIDO" | "APROBADO" | "BLOQUEADO";
  decision?: string | null;
  note?: string | null;
  actorId?: string | null;
};

/**
 * Revisión humana de un caso (plan §2.14): cambia el estado de riesgo
 * con motivo + auditoría. APROBADO/BLOQUEADO cierran el caso
 * (resolvedAt). Un caso cerrado solo se puede reabrir a REVISION.
 * Idempotente por estado: repetir el mismo estado final no duplica nada.
 */
export async function reviewFraudCase(
  caseId: string,
  input: ReviewFraudCaseInput,
) {
  const before = await db.fraudCase.findUnique({ where: { id: caseId } });
  if (!before) throw notFound("Caso de fraude no existe");
  const wasFinal = (FINAL_RISK_STATUSES as readonly string[]).includes(before.status);
  const isFinal = (FINAL_RISK_STATUSES as readonly string[]).includes(input.riskStatus);
  // Un caso cerrado (APROBADO/BLOQUEADO) solo se puede reabrir a
  // REVISION: nunca saltar de un estado final a otro sin reapertura.
  if (wasFinal && input.riskStatus !== "REVISION") {
    throw new Error(`Un caso ${before.status} solo se puede reabrir a REVISION (actual: ${input.riskStatus})`);
  }
  const updated = await db.fraudCase.update({
    where: { id: caseId },
    data: {
      status: input.riskStatus,
      decision: input.decision ?? before.decision,
      reviewedById: input.actorId ?? before.reviewedById,
      resolvedAt: isFinal ? (before.resolvedAt ?? new Date()) : null,
    },
  });
  await logAudit({
    actorId: input.actorId ?? null,
    action: "fraud.case.review",
    entity: "FraudCase",
    entityId: caseId,
    before: { status: before.status, decision: before.decision },
    after: { status: input.riskStatus, decision: input.decision ?? null, note: input.note ?? null },
    ipAddress: null,
  });
  return updated;
}

/**
 * Retiene una comisión AVAILABLE (vuelve a RETAINED) por sospecha de
 * fraude. La liberación posterior la decide la revisión humana (el
 * retention-sweep solo libera RETAINED vencidas; un caso abierto no
 * impide la liberación automática — ver riesgo en el reporte S6).
 */
export async function holdCommission(
  commissionId: string,
  actorId: string | null,
  reason: string,
) {
  const commission = await db.commission.findUnique({ where: { id: commissionId } });
  if (!commission) throw new Error("Comisión no existe");
  if (commission.status !== "AVAILABLE") {
    throw new Error(`Solo se puede retener una comisión AVAILABLE (actual: ${commission.status})`);
  }
  const updated = await db.commission.update({
    where: { id: commissionId },
    data: { status: "RETAINED" },
  });
  await logAudit({
    actorId,
    action: "fraud.commission.hold",
    entity: "Commission",
    entityId: commissionId,
    before: { status: "AVAILABLE", amount: commission.amount },
    after: { status: "RETAINED", reason },
  });
  return updated;
}

// ---------------------------------------------------------------- contracargo
export type HandleChargebackInput = {
  orderId?: string | null;
  orderCode?: string | null;
  provider: string;
  providerRef?: string | null;
  amount?: number | null;
  currency?: string | null;
  eventId?: string | null;
};

/**
 * Gestión del contracargo (S5 solo abre el caso de conciliación; S9-int
 * añade la parte financiera):
 *  1. Parte financiera (`applyChargeback` en operations.ts, único camino
 *     para mover dinero): Payment APROBADO → CONTRACARGO, asiento
 *     CONTRACARGO en ledger y ajuste de comisiones vía
 *     `adjustCommissionsForRefund`. Idempotente: un segundo contracargo
 *     sobre el mismo pago no duplica asientos. Si el pago no estaba
 *     APROBADO (p. ej. PENDIENTE), no hay dinero que mover y solo se
 *     marca el caso. Los boletos NO se tocan: la anulación es decisión
 *     humana desde el caso de fraude / bloqueo de boletos.
 *  2. Marca el pedido en Revisión (Order → DISPUTADO si estaba
 *     CONFIRMADO) y abre caso de fraude del pedido y, si hay afiliado,
 *     del afiliado.
 *
 * La importación de operations.ts es dinámica: operations.ts importa
 * orders.ts y orders.ts importa este módulo (bloqueo de compras), así que
 * un import estático crearía un ciclo. El contracargo llega por webhook
 * (abre caso de conciliación) y se gestiona aquí cuando `fraud-scan`
 * procesa los casos `contracargo` abiertos (≤ 1 h) o al llamar directo.
 * Idempotente por regla+entidad (flagForReview no duplica casos).
 */
export async function handleChargeback(input: HandleChargebackInput) {
  const order = input.orderId
    ? await db.order.findUnique({ where: { id: input.orderId } })
    : input.orderCode
      ? await db.order.findUnique({ where: { code: input.orderCode.toUpperCase() } })
      : null;
  if (!order) {
    return { handled: false, created: false, reason: "pedido no encontrado para el contracargo", orderCase: null, affiliateCase: null };
  }
  const reason =
    `Contracargo notificado por ${input.provider}` +
    (input.amount !== null && input.amount !== undefined ? ` (${input.amount} ${input.currency ?? ""})` : "") +
    (input.providerRef ? ` ref ${input.providerRef}` : "") +
    ". Revisión humana obligatoria antes de decidir reembolso/ajuste.";
  const orderCase = await flagForReview(db, {
    rule: FRAUD_RULES.CHARGEBACK,
    reason,
    entityType: "Order",
    entityId: order.id,
  });
  let affiliateCase = null;
  if (order.affiliateId) {
    affiliateCase = await flagForReview(db, {
      rule: FRAUD_RULES.CHARGEBACK,
      reason: `Contracargo en pedido referido ${order.code}: ${reason}`,
      entityType: "User",
      entityId: order.affiliateId,
    });
  }
  // Parte financiera (S9-int): mueve el dinero solo si el pago estaba
  // APROBADO; si no hay nada que mover, devuelve moved:false y el caso
  // de fraude igual queda registrado.
  const { applyChargeback } = await import("./payments/operations");
  const financial = await applyChargeback(order.id, {
    providerRef: input.providerRef ?? null,
    reason,
    source: "webhook",
  });
  if (!financial.moved && order.status === "CONFIRMADO") {
    await db.order.update({ where: { id: order.id }, data: { status: "DISPUTADO" } });
    await logAudit({
      action: "fraud.chargeback.order-disputed",
      entity: "Order",
      entityId: order.id,
      before: { status: "CONFIRMADO" },
      after: { status: "DISPUTADO", provider: input.provider, eventId: input.eventId ?? null },
    });
  }
  return {
    handled: true,
    created: orderCase.created || (affiliateCase?.created ?? false),
    orderCase: orderCase.fraudCase,
    affiliateCase: affiliateCase?.fraudCase ?? null,
    financial,
  };
}

// ---------------------------------------------------------------- escaneo (job fraud-scan)
/**
 * Escanea pedidos recientes y aplica las reglas. Idempotente por
 * flagForReview (no duplica casos abiertos). Devuelve conteo de casos
 * nuevos. Pensado para el job `fraud-scan` (cada hora) y para llamarlo
 * tras crear un pedido desde el job de conciliación de contracargos.
 */
export async function scanRecentOrders(
  input: { sinceMinutes?: number; now?: Date } = {},
): Promise<{ scanned: number; flagged: number; rules: Record<string, number> }> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - (input.sinceMinutes ?? 60) * 60 * 1000);
  const orders = await db.order.findMany({
    where: { createdAt: { gte: since } },
    select: { id: true, buyerEmail: true, buyerPhone: true, userId: true, affiliateId: true },
  });
  const rules: Record<string, number> = {};
  let flagged = 0;
  const count = (rule: string) => {
    rules[rule] = (rules[rule] ?? 0) + 1;
    flagged += 1;
  };
  for (const order of orders) {
    const velocity = await checkPurchaseVelocity(db, {
      buyerEmail: order.buyerEmail,
      buyerPhone: order.buyerPhone,
      now,
    });
    if (velocity.flagged) {
      // Un caso por COMPRADOR (no por pedido): una ráfaga es un solo
      // hallazgo; flagForReview lo deduplica por regla+entidad.
      const r = await flagForReview(db, {
        rule: FRAUD_RULES.VELOCITY,
        reason: `Velocidad sospechosa: ${velocity.reason} (comprador ${order.buyerEmail})`,
        entityType: "Buyer",
        entityId: order.buyerEmail,
      });
      if (r.created) count(FRAUD_RULES.VELOCITY);
    }
    const self = await detectSelfReferralAttempt(db, {
      orderId: order.id,
      affiliateId: order.affiliateId,
      buyerEmail: order.buyerEmail,
      userId: order.userId,
      buyerPhone: order.buyerPhone,
    });
    if (self?.created) count(FRAUD_RULES.SELF_REFERRAL);
    const refunds = await detectRepeatedRefunds(db, order.buyerEmail, undefined, now);
    if (refunds.flagged) {
      const r = await flagForReview(db, {
        rule: refunds.chargebacks > 0 ? FRAUD_RULES.REPEATED_CHARGEBACKS : FRAUD_RULES.REPEATED_REFUNDS,
        reason: `Comprador ${order.buyerEmail}: ${refunds.reason}`,
        entityType: "Buyer",
        entityId: order.buyerEmail,
      });
      if (r.created) count(r.fraudCase.rule);
    }
  }
  // Contracargos abiertos en conciliación sin caso de fraude: gestionarlos.
  const openChargebacks = await db.reconciliationCase.findMany({
    where: { status: "ABIERTO" },
    select: { id: true, detail: true, provider: true, amount: true, currency: true },
  });
  for (const c of openChargebacks) {
    const detail = c.detail as { kind?: string; orderCode?: string; eventId?: string; providerRef?: string } | null;
    if (detail?.kind !== "contracargo" || !detail.orderCode) continue;
    const res = await handleChargeback({
      orderCode: detail.orderCode,
      provider: c.provider,
      providerRef: detail.providerRef ?? null,
      amount: c.amount,
      currency: c.currency,
      eventId: detail.eventId ?? null,
    });
    if (res.handled && res.created) count(FRAUD_RULES.CHARGEBACK);
  }
  return { scanned: orders.length, flagged, rules };
}
