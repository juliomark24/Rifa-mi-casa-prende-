// Afiliados — comisiones (plan §2.4).
//
// S5 crea la comisión al CONFIRMAR el pago (10% solo sobre pagos
// confirmados, nunca sobre reservas ni pendientes) y la ajusta al
// REEMBOLSAR. S6 gestiona después: retención (PENDING → RETAINED),
// liberación tras el período de riesgo (retention-sweep, ya existe),
// retiros y fraude.
//
// CONVENCIÓN DE LEDGER (acordada en S5; S6 la mantiene):
//  - La comisión se contabiliza como COMISION con monto NEGATIVO
//    (pasivo comprometido con el afiliado) en el momento de la venta.
//  - El reembolso la revierte con un AJUSTE POSITIVO del mismo monto
//    que referencia el asiento original. Nunca se borra ni se edita
//    ningún asiento (ledger append-only, plan §2.3).
//
// HOOK PARA S6 — `adjustCommissionsForRefund`:
//  - PENDING / RETAINED → ADJUSTED + AJUSTE compensatorio (hecho en S5).
//  - AVAILABLE / PAID → NO se ajustan aquí: si una comisión ya liberada o
//    pagada se reembolsa, queda como saldo negativo a compensar con
//    futuras comisiones (plan §2.4) y S6 debe implementarlo; S5 deja el
//    caso abierto en ReconciliationCase (`comision-pagada-reembolsada`)
//    para revisión humana y nunca lo ajusta en silencio.
import type { Commission, Order } from "../generated/prisma/client";
import { db, type Tx } from "./db";
import { appendLedgerEntry } from "./ledger";
import { commissionForSale } from "./money";

type Client = typeof db | Tx;

/** Comisiones que S5 puede ajustar directamente (aún no liberadas/pagadas). */
export const ADJUSTABLE_COMMISSION_STATUSES = ["PENDING", "RETAINED"] as const;

/**
 * Crea la comisión del 10% de una venta confirmada (una por pedido).
 * Idempotente por pedido: si ya existe una comisión para el pedido, la
 * devuelve sin crear otra ni duplicar el asiento. Sin afiliado, o con
 * comisión 0, no crea nada. Se llama DENTRO de la transacción de
 * confirmación del pago (mismo tx que el asiento VENTA).
 */
export async function createCommissionForOrder(
  tx: Tx,
  order: Order,
): Promise<Commission | null> {
  if (!order.affiliateId) return null;
  const existing = await tx.commission.findFirst({
    where: { orderId: order.id },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  const amount = await commissionForSale(order.totalAmount);
  if (amount <= 0) return null;
  const commission = await tx.commission.create({
    data: {
      affiliateId: order.affiliateId,
      orderId: order.id,
      ticketId: null,
      amount,
      currency: order.currency,
      status: "PENDING",
    },
  });
  await appendLedgerEntry(tx, {
    type: "COMISION",
    amount: -amount,
    currency: order.currency,
    refType: "Commission",
    refId: commission.id,
    metadata: {
      orderId: order.id,
      orderCode: order.code,
      affiliateId: order.affiliateId,
      affiliateCode: order.affiliateCode,
    },
  });
  return commission;
}

export type CommissionAdjustment = {
  adjusted: Array<{ commissionId: string; amount: number; ledgerEntryId: string }>;
  /** Comisiones AVAILABLE/PAID que S6 debe compensar (saldo negativo). */
  pendingHumanReview: Array<{ commissionId: string; amount: number; status: string }>;
};

/**
 * Ajusta las comisiones de un pedido reembolsado (plan §2.4, P6).
 * PENDING/RETAINED → ADJUSTED + asiento AJUSTE positivo que revierte el
 * COMISION negativo original (referenciado en metadata). Se llama DENTRO
 * de la transacción de reembolso. Las comisiones AVAILABLE/PAID NO se
 * tocan: se devuelven en `pendingHumanReview` para que S6 las compense
 * como saldo negativo (y el refund crea el caso de conciliación).
 */
export async function adjustCommissionsForRefund(
  tx: Tx,
  order: Order,
  input: { reason?: string } = {},
): Promise<CommissionAdjustment> {
  const commissions = await tx.commission.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: "asc" },
  });
  const result: CommissionAdjustment = { adjusted: [], pendingHumanReview: [] };
  for (const commission of commissions) {
    if (
      commission.status !== "PENDING" &&
      commission.status !== "RETAINED"
    ) {
      result.pendingHumanReview.push({
        commissionId: commission.id,
        amount: commission.amount,
        status: commission.status,
      });
      continue;
    }
    await tx.commission.update({
      where: { id: commission.id },
      data: { status: "ADJUSTED" },
    });
    const original = await tx.ledgerEntry.findFirst({
      where: { refType: "Commission", refId: commission.id, type: "COMISION" },
      orderBy: { createdAt: "asc" },
    });
    const reversal = await appendLedgerEntry(tx, {
      type: "AJUSTE",
      amount: commission.amount,
      currency: commission.currency,
      refType: "Commission",
      refId: commission.id,
      metadata: {
        orderId: order.id,
        orderCode: order.code,
        affiliateId: commission.affiliateId,
        reason: input.reason ?? "reembolso del pedido",
        reversesLedgerEntryId: original?.id ?? null,
      },
    });
    result.adjusted.push({
      commissionId: commission.id,
      amount: commission.amount,
      ledgerEntryId: reversal.id,
    });
  }
  return result;
}

/** Alias del cliente transaccional para reuso fuera de tx (lecturas S6). */
export type { Client as AffiliatesClient };

// ================================================================ S6 =====
// Retención PENDING → RETAINED, retiros, compensación de comisiones
// liberadas/pagadas reembolsadas y saldos del afiliado (plan §2.4).
//
// DECISIONES DOCUMENTADAS (para confirmar por el dueño/coordinador):
//  - RETENCIÓN: la comisión entra en retención (PENDING → RETAINED) en
//    cuanto se genera: RETAINED es el estado durante el período de
//    riesgo. El job `commission-retention` la mueve; `retention-sweep`
//    (S8, sin tocar) la libera a AVAILABLE cuando pasan RETENTION_DAYS
//    (defecto 7) Y la rifa está cerrada o su sorteo ya pasó (lo que
//    ocurra después, plan §2.4). PENDING es, por tanto, un estado
//    transitorio entre la confirmación del pago y la siguiente pasada
//    del job de retención.
//  - RETENTION_DAYS: Setting RETENTION_DAYS, o env, o 7 por defecto
//    (misma fuente que retention-sweep; ver `getRetentionDays`).
//  - MIN_WITHDRAWAL: Setting MIN_WITHDRAWAL, o env, o 500 (RD$500,
//    defecto del plan §2.4). Entero en unidades mayores.
//  - DOBLE APROBACIÓN (§2.20, "aprobar un retiro grande"): retiros con
//    monto > WITHDRAWAL_DOUBLE_APPROVAL_THRESHOLD (Setting o env,
//    defecto 10.000) exigen DOS aprobadores distintos. La primera
//    aprobación queda en `approvedById` (el retiro sigue REQUESTED);
//    la segunda, de otro admin, lo pasa a APPROVED y queda en
//    ChangeLog (campo secondApproval) + AuditLog. Sin cambio de schema:
//    no existe estado intermedio en WithdrawalStatus.
//  - COMPENSACIÓN (plan §2.4): si un pedido se reembolsa con su comisión
//    AVAILABLE (liberada, dinero aún no pagado) → ADJUSTED + AJUSTE
//    positivo que revierte el COMISION original (igual que S5 hace con
//    PENDING/RETAINED: el dinero no salió, no hay saldo negativo).
//    Si estaba PAID (dinero ya pagado al afiliado) → ADJUSTED + AJUSTE
//    NEGATIVO que crea el saldo negativo a compensar con futuras
//    comisiones. La compensación la aplica el job
//    `compensate-paid-commissions` (S5 no se toca: el reembolso abre el
//    caso `comision-pagada-reembolsada` y el job lo resuelve).
//  - SALDO DEL AFILIADO (derivado, nunca columna editable):
//      disponible = Σ comisiones AVAILABLE + Σ AJUSTE negativos de
//        compensación (kind compensacion-comision-pagada). Puede ser
//        negativo: ese es el saldo negativo del plan §2.4.
//      comprometido = Σ PENDING + Σ RETAINED.
//      pagado = Σ PAID.
//  - PAGO DE RETIRO: al pagar se marcan PAID las comisiones AVAILABLE
//    más antiguas (FIFO) hasta cubrir el monto, en la misma transacción
//    que el asiento RETIRO. Así el saldo disponible baja exactamente lo
//    pagado y no se puede pagar dos veces lo mismo.

import { ApiError, conflict, notFound } from "./errors";
import { logAudit, logChange } from "./audit";
import { queueNotificationSafe } from "./notifications";
import { ledgerEntriesFor } from "./ledger";

/** Lee un entero de Setting (o env) con defecto; nunca NaN ni negativo. */
export async function getSettingInt(
  key: string,
  envVar: string,
  defaultValue: number,
): Promise<number> {
  try {
    const setting = await db.setting.findUnique({ where: { key } });
    if (setting) {
      const n = Number(setting.value);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) return n;
    }
  } catch {
    // Sin BD disponible: cae al env.
  }
  const env = Number(process.env[envVar] ?? String(defaultValue));
  return Number.isFinite(env) && Number.isInteger(env) && env >= 0 ? env : defaultValue;
}

/** Días de retención (Setting RETENTION_DAYS, env o 7). Misma fuente que retention-sweep. */
export async function getRetentionDays(): Promise<number> {
  return getSettingInt("RETENTION_DAYS", "RETENTION_DAYS", 7);
}

/** Retiro mínimo (Setting MIN_WITHDRAWAL, env o 500). Entero, unidades mayores. */
export async function getMinWithdrawal(): Promise<number> {
  return getSettingInt("MIN_WITHDRAWAL", "MIN_WITHDRAWAL", 500);
}

/** Umbral de doble aprobación de retiros (Setting, env o 10.000). */
export async function getDoubleApprovalThreshold(): Promise<number> {
  return getSettingInt(
    "WITHDRAWAL_DOUBLE_APPROVAL_THRESHOLD",
    "WITHDRAWAL_DOUBLE_APPROVAL_THRESHOLD",
    10000,
  );
}

// ---------------------------------------------------------------- retención
export type RetentionResult = { moved: number; commissionIds: string[] };

/**
 * Job `commission-retention`: mueve PENDING → RETAINED. Idempotente (la
 * segunda pasada no encuentra PENDING). La retención empieza al generarse
 * la comisión; el período de riesgo lo cierra `retention-sweep` (S8).
 */
export async function retainDueCommissions(
  client: Client = db,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const pending = await client.commission.findMany({
    where: { status: "PENDING" },
    select: { id: true, affiliateId: true, orderId: true, amount: true },
  });
  if (pending.length === 0) return { moved: 0, commissionIds: [] };
  const ids = pending.map((c) => c.id);
  const res = await client.commission.updateMany({
    where: { id: { in: ids }, status: "PENDING" },
    data: { status: "RETAINED" },
  });
  await logAudit({
    action: "affiliate.commission.retained",
    entity: "Commission",
    after: {
      moved: res.count,
      commissionIds: ids,
      by: "commission-retention",
      at: now.toISOString(),
    },
  });
  return { moved: res.count, commissionIds: ids };
}

// ---------------------------------------------------------------- saldos
export type AffiliateBalance = {
  affiliateId: string;
  currency: string;
  pending: number;
  retained: number;
  available: number; // neto: AVAILABLE + compensaciones negativas (puede ser < 0)
  paid: number;
  /** Saldo negativo pendiente de absorber (≥ 0): −disponible cuando el
    disponible neto es negativo (comisión pagada y luego reembolsada);
    se absorbe solo cuando llegan nuevas comisiones AVAILABLE. */
  negativeBalance: number;
  /** Comprometido = pending + retained. */
  committed: number;
  /** Retiros APPROVED aún no pagados (reservan saldo disponible). */
  approvedOutstanding: number;
  /** Disponible para una NUEVA solicitud: available − approvedOutstanding. */
  availableForNewWithdrawal: number;
};

const COMPENSATION_KIND = "compensacion-comision-pagada";

/** Suma de AJUSTE negativos de compensación de un afiliado (≤ 0). */
export async function compensationDebit(
  client: Client,
  affiliateId: string,
  currency: string,
): Promise<number> {
  const commissions = await client.commission.findMany({
    where: { affiliateId, currency },
    select: { id: true },
  });
  if (commissions.length === 0) return 0;
  const entries = await client.ledgerEntry.findMany({
    where: {
      type: "AJUSTE",
      refType: "Commission",
      refId: { in: commissions.map((c) => c.id) },
    },
    select: { amount: true, metadata: true },
  });
  let debit = 0;
  for (const e of entries) {
    const meta = e.metadata as { kind?: string } | null;
    if (meta?.kind === COMPENSATION_KIND && e.amount < 0) debit += e.amount;
  }
  return debit;
}

/** Saldo derivado del afiliado (por moneda). Nunca una columna editable. */
export async function getAffiliateBalance(
  client: Client,
  affiliateId: string,
  currency = "DOP",
): Promise<AffiliateBalance> {
  const commissions = await client.commission.findMany({
    where: { affiliateId, currency },
    select: { status: true, amount: true },
  });
  const sum = (status: string) =>
    commissions.filter((c) => c.status === status).reduce((acc, c) => acc + c.amount, 0);
  const debit = await compensationDebit(client, affiliateId, currency);
  const withdrawals = await client.withdrawal.findMany({
    where: { affiliateId, currency, status: "APPROVED" },
    select: { amount: true },
  });
  const approvedOutstanding = withdrawals.reduce((acc, w) => acc + w.amount, 0);
  const available = sum("AVAILABLE") + debit;
  return {
    affiliateId,
    currency,
    pending: sum("PENDING"),
    retained: sum("RETAINED"),
    available,
    paid: sum("PAID"),
    // El saldo negativo es el descubierto neto: si el disponible neto es
    // negativo, el afiliado debe esa cantidad (se compensa con futuras
    // comisiones AVAILABLE). Si ya se absorbió, vuelve a 0.
    negativeBalance: available < 0 ? -available : 0,
    committed: sum("PENDING") + sum("RETAINED"),
    approvedOutstanding,
    availableForNewWithdrawal: available - approvedOutstanding,
  };
}

/** ¿Tiene el afiliado un caso de fraude abierto que bloquee retiros? */
export async function affiliateHasOpenFraudBlock(
  client: Client,
  affiliateId: string,
): Promise<{ blocked: boolean; caseId?: string; status?: string }> {
  const c = await client.fraudCase.findFirst({
    where: {
      entityType: "User",
      entityId: affiliateId,
      status: { in: ["REVISION", "RETENIDO", "BLOQUEADO"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!c) return { blocked: false };
  return { blocked: true, caseId: c.id, status: c.status };
}

// ---------------------------------------------------------------- retiros
export type WithdrawalView = {
  id: string;
  affiliateId: string;
  amount: number;
  currency: string;
  status: string;
  approvedById: string | null;
  receiptRef: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function presentWithdrawal(w: {
  id: string;
  affiliateId: string;
  amount: number;
  currency: string;
  status: string;
  approvedById: string | null;
  receiptRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}): WithdrawalView {
  return {
    id: w.id,
    affiliateId: w.affiliateId,
    amount: w.amount,
    currency: w.currency,
    status: w.status,
    approvedById: w.approvedById,
    receiptRef: w.receiptRef,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

/**
 * Solicitud de retiro (plan §2.4): solo saldo AVAILABLE neto (menos
 * retiros APPROVED pendientes), monto ≥ mínimo configurable, entero.
 * El afiliado en revisión/retenido/bloqueado por fraude no puede retirar.
 */
export async function requestWithdrawal(
  affiliateId: string,
  input: { amount: number; currency?: string },
): Promise<WithdrawalView> {
  const currency = input.currency ?? "DOP";
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new ApiError(400, "El monto del retiro debe ser un entero mayor que 0", "VALIDATION_ERROR");
  }
  const min = await getMinWithdrawal();
  if (input.amount < min) {
    throw new ApiError(
      400,
      `El retiro mínimo es ${min} ${currency}`,
      "WITHDRAWAL_BELOW_MINIMUM",
    );
  }
  const fraud = await affiliateHasOpenFraudBlock(db, affiliateId);
  if (fraud.blocked) {
    throw conflict(
      `El afiliado está en revisión de fraude (${fraud.status}); no puede solicitar retiros hasta resolver el caso`,
      "AFFILIATE_FRAUD_HOLD",
    );
  }
  const balance = await getAffiliateBalance(db, affiliateId, currency);
  if (input.amount > balance.availableForNewWithdrawal) {
    throw conflict(
      `Saldo disponible insuficiente: ${balance.availableForNewWithdrawal} ${currency} (solicitado ${input.amount})`,
      "INSUFFICIENT_AVAILABLE_BALANCE",
    );
  }
  const withdrawal = await db.withdrawal.create({
    data: { affiliateId, amount: input.amount, currency, status: "REQUESTED" },
  });
  await logAudit({
    actorId: affiliateId,
    action: "affiliate.withdrawal.requested",
    entity: "Withdrawal",
    entityId: withdrawal.id,
    after: { amount: input.amount, currency, availableAfter: balance.availableForNewWithdrawal - input.amount },
  });
  await queueNotificationSafe({
    event: "retiro_afiliado",
    channel: "EMAIL",
    recipient: (await db.user.findUnique({ where: { id: affiliateId } }))?.email ?? "",
    data: { amount: input.amount, currency, status: "REQUESTED" },
    dedupeKey: `retiro:${withdrawal.id}:requested`,
  });
  return presentWithdrawal(withdrawal);
}

export type ApproveWithdrawalResult = {
  withdrawal: WithdrawalView;
  /** true si esta aprobación lo deja APPROVED; false si falta la 2ª aprobación. */
  fullyApproved: boolean;
  approvalsNeeded: number;
  approvalsDone: number;
};

/**
 * Aprueba un retiro (permiso withdrawals.approve; doble aprobación si el
 * monto supera el umbral). Re-verifica saldo disponible y fraude en el
 * momento de aprobar. Idempotente por estado: aprobar un retiro ya
 * APPROVED/PAID devuelve el estado sin duplicar aprobaciones.
 */
export async function approveWithdrawal(
  withdrawalId: string,
  approverId: string,
): Promise<ApproveWithdrawalResult> {
  const withdrawal = await db.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw notFound("Retiro no existe");
  if (withdrawal.status === "APPROVED" || withdrawal.status === "PAID") {
    return { withdrawal: presentWithdrawal(withdrawal), fullyApproved: true, approvalsNeeded: 1, approvalsDone: 2 };
  }
  if (withdrawal.status !== "REQUESTED") {
    throw conflict(`Solo se puede aprobar un retiro REQUESTED (actual: ${withdrawal.status})`, "WITHDRAWAL_NOT_APPROVABLE");
  }
  const fraud = await affiliateHasOpenFraudBlock(db, withdrawal.affiliateId);
  if (fraud.blocked) {
    throw conflict(
      `El afiliado está en revisión de fraude (${fraud.status}); no se puede aprobar el retiro`,
      "AFFILIATE_FRAUD_HOLD",
    );
  }
  const threshold = await getDoubleApprovalThreshold();
  const needsDouble = withdrawal.amount > threshold;
  // El retiro aún no está APPROVED, así que no está en
  // approvedOutstanding: availableForNewWithdrawal ya descuenta los
  // demás retiros APPROVED pendientes de pago.
  const balance = await getAffiliateBalance(db, withdrawal.affiliateId, withdrawal.currency);
  if (withdrawal.amount > balance.availableForNewWithdrawal) {
    throw conflict(
      `Saldo disponible insuficiente para aprobar: ${balance.availableForNewWithdrawal} ${withdrawal.currency} (retiro ${withdrawal.amount})`,
      "INSUFFICIENT_AVAILABLE_BALANCE",
    );
  }

  // Segunda aprobación: otro admin distinto del primero.
  if (needsDouble && withdrawal.approvedById) {
    if (withdrawal.approvedById === approverId) {
      throw conflict(
        "La segunda aprobación debe hacerla otro administrador distinto del primero",
        "DOUBLE_APPROVAL_SAME_ADMIN",
      );
    }
    const updated = await db.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: "APPROVED" },
    });
    await logChange({
      actorId: approverId,
      entity: "Withdrawal",
      entityId: withdrawalId,
      field: "secondApproval",
      beforeValue: withdrawal.approvedById,
      afterValue: approverId,
      reason: `Doble aprobación: retiro ${withdrawal.amount} > umbral ${threshold}`,
      approvedById: approverId,
    });
    await logAudit({
      actorId: approverId,
      action: "withdrawals.approve.second",
      entity: "Withdrawal",
      entityId: withdrawalId,
      before: { status: "REQUESTED", firstApprover: withdrawal.approvedById },
      after: { status: "APPROVED", secondApprover: approverId },
    });
    return { withdrawal: presentWithdrawal(updated), fullyApproved: true, approvalsNeeded: 2, approvalsDone: 2 };
  }

  // Primera aprobación (única si no supera el umbral).
  const updated = await db.withdrawal.update({
    where: { id: withdrawalId },
    data: {
      approvedById: approverId,
      ...(needsDouble ? {} : { status: "APPROVED" }),
    },
  });
  await logAudit({
    actorId: approverId,
    action: needsDouble ? "withdrawals.approve.first" : "withdrawals.approve",
    entity: "Withdrawal",
    entityId: withdrawalId,
    before: { status: "REQUESTED" },
    after: {
      status: needsDouble ? "REQUESTED (falta 2ª aprobación)" : "APPROVED",
      approver: approverId,
      needsDouble,
      threshold,
    },
  });
  return {
    withdrawal: presentWithdrawal(updated),
    fullyApproved: !needsDouble,
    approvalsNeeded: needsDouble ? 2 : 1,
    approvalsDone: 1,
  };
}

/** Rechaza un retiro REQUESTED (con motivo en auditoría). */
export async function rejectWithdrawal(
  withdrawalId: string,
  actorId: string,
  reason?: string | null,
): Promise<WithdrawalView> {
  const withdrawal = await db.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw notFound("Retiro no existe");
  if (withdrawal.status === "REJECTED") return presentWithdrawal(withdrawal);
  if (withdrawal.status !== "REQUESTED") {
    throw conflict(`Solo se puede rechazar un retiro REQUESTED (actual: ${withdrawal.status})`, "WITHDRAWAL_NOT_REJECTABLE");
  }
  const updated = await db.withdrawal.update({
    where: { id: withdrawalId },
    data: { status: "REJECTED" },
  });
  await logAudit({
    actorId,
    action: "withdrawals.reject",
    entity: "Withdrawal",
    entityId: withdrawalId,
    before: { status: "REQUESTED" },
    after: { status: "REJECTED", reason: reason ?? null },
  });
  return presentWithdrawal(updated);
}

/**
 * Paga un retiro APPROVED (permiso withdrawals.pay): asiento RETIRO
 * negativo en ledger + comisiones AVAILABLE más antiguas marcadas PAID
 * (FIFO) hasta cubrir el monto, todo en UNA transacción. Idempotente:
 * pagar un retiro ya PAID devuelve el estado sin duplicar asientos.
 * Sin aprobación admin registrada no se paga (regla dura S6).
 */
export async function payWithdrawal(
  withdrawalId: string,
  actorId: string,
  receiptRef?: string | null,
): Promise<{ withdrawal: WithdrawalView; commissionsPaid: string[]; alreadyPaid: boolean }> {
  const withdrawal = await db.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw notFound("Retiro no existe");
  if (withdrawal.status === "PAID") {
    return { withdrawal: presentWithdrawal(withdrawal), commissionsPaid: [], alreadyPaid: true };
  }
  if (withdrawal.status !== "APPROVED") {
    throw conflict(`Solo se puede pagar un retiro APPROVED (actual: ${withdrawal.status})`, "WITHDRAWAL_NOT_PAYABLE");
  }
  if (!withdrawal.approvedById) {
    throw conflict("El retiro no tiene aprobación registrada; no se puede pagar", "WITHDRAWAL_NOT_APPROVED");
  }

  const paid = await db.$transaction(async (tx: Tx) => {
    // Guardia dentro de la transacción (carrera entre dos pagos).
    const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!fresh) throw notFound("Retiro no existe");
    if (fresh.status === "PAID") return { replay: true as const, commissionsPaid: [] as string[] };
    if (fresh.status !== "APPROVED") {
      throw conflict(`Solo se puede pagar un retiro APPROVED (actual: ${fresh.status})`, "WITHDRAWAL_NOT_PAYABLE");
    }
    // Re-verificación de saldo en la transacción: las comisiones
    // AVAILABLE deben cubrir el monto (neto de compensaciones).
    const commissions = await tx.commission.findMany({
      where: { affiliateId: fresh.affiliateId, currency: fresh.currency, status: "AVAILABLE" },
      orderBy: { createdAt: "asc" },
    });
    const debit = await compensationDebit(tx, fresh.affiliateId, fresh.currency);
    const availableNet = commissions.reduce((acc, c) => acc + c.amount, 0) + debit;
    if (fresh.amount > availableNet) {
      throw conflict(
        `Saldo disponible insuficiente para pagar: ${availableNet} ${fresh.currency} (retiro ${fresh.amount})`,
        "INSUFFICIENT_AVAILABLE_BALANCE",
      );
    }
    // FIFO: marcar PAID las más antiguas hasta cubrir el monto.
    let remaining = fresh.amount;
    const commissionsPaid: string[] = [];
    for (const c of commissions) {
      if (remaining <= 0) break;
      await tx.commission.update({ where: { id: c.id }, data: { status: "PAID" } });
      commissionsPaid.push(c.id);
      remaining -= c.amount;
    }
    await appendLedgerEntry(tx, {
      type: "RETIRO",
      amount: -fresh.amount,
      currency: fresh.currency,
      refType: "Withdrawal",
      refId: fresh.id,
      metadata: {
        affiliateId: fresh.affiliateId,
        approvedById: fresh.approvedById,
        receiptRef: receiptRef ?? null,
        commissionsPaid,
      },
    });
    await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: "PAID", receiptRef: receiptRef ?? null },
    });
    return { replay: false as const, commissionsPaid };
  });

  if (paid.replay) {
    const reloaded = await db.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!reloaded) throw notFound("Retiro no existe");
    return { withdrawal: presentWithdrawal(reloaded), commissionsPaid: [], alreadyPaid: true };
  }

  const updated = await db.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!updated) throw notFound("Retiro no existe");
  await logAudit({
    actorId,
    action: "withdrawals.pay",
    entity: "Withdrawal",
    entityId: withdrawalId,
    before: { status: "APPROVED", approvedById: withdrawal.approvedById },
    after: { status: "PAID", receiptRef: receiptRef ?? null, commissionsPaid: paid.commissionsPaid },
  });
  const affiliate = await db.user.findUnique({ where: { id: withdrawal.affiliateId } });
  if (affiliate) {
    await queueNotificationSafe({
      event: "retiro_afiliado",
      channel: "EMAIL",
      recipient: affiliate.email,
      data: { amount: withdrawal.amount, currency: withdrawal.currency, status: "PAID", receiptRef: receiptRef ?? null },
      dedupeKey: `retiro:${withdrawal.id}:paid`,
    });
  }
  return { withdrawal: presentWithdrawal(updated), commissionsPaid: paid.commissionsPaid, alreadyPaid: false };
}

// ---------------------------------------------------------------- compensación
export type CompensationResult = {
  compensated: Array<{ commissionId: string; amount: number; kind: "reversal" | "negative-balance" }>;
  /** Comisiones que ya tenían compensación (idempotente, sin duplicar). */
  alreadyCompensated: string[];
};

/**
 * Compensa las comisiones de un pedido REEMBOLSADO que S5 dejó en
 * revisión humana (AVAILABLE/PAID). Idempotente por comisión: si ya
 * existe el AJUSTE de compensación, no se duplica.
 *  - AVAILABLE → ADJUSTED + AJUSTE POSITIVO (revierte el COMISION; el
 *    dinero no salió, no hay saldo negativo).
 *  - PAID → ADJUSTED + AJUSTE NEGATIVO (saldo negativo a compensar con
 *    futuras comisiones, plan §2.4).
 * Se llama desde el job `compensate-paid-commissions` (o manualmente).
 */
export async function compensateRefundedCommissions(
  tx: Tx,
  orderId: string,
  input: { actorId?: string | null; reason?: string } = {},
): Promise<CompensationResult> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { commissions: true },
  });
  if (!order) throw notFound("Pedido no existe");
  const result: CompensationResult = { compensated: [], alreadyCompensated: [] };
  for (const commission of order.commissions) {
    // Idempotencia PRIMERO (antes del filtro por estado): una comisión
    // ya compensada está ADJUSTED y no volvería a entrar al filtro, pero
    // debe reportarse como alreadyCompensated, no ignorarse en silencio.
    const entries = await ledgerEntriesFor(tx, "Commission", commission.id);
    const hasCompensation = entries.some((e) => {
      const meta = e.metadata as { kind?: string } | null;
      return (
        e.type === "AJUSTE" &&
        (meta?.kind === COMPENSATION_KIND || meta?.kind === "compensacion-comision-disponible")
      );
    });
    if (hasCompensation) {
      result.alreadyCompensated.push(commission.id);
      continue;
    }
    if (commission.status !== "AVAILABLE" && commission.status !== "PAID") continue;
    const original = entries.find((e) => e.type === "COMISION");
    if (commission.status === "AVAILABLE") {
      await tx.commission.update({ where: { id: commission.id }, data: { status: "ADJUSTED" } });
      await appendLedgerEntry(tx, {
        type: "AJUSTE",
        amount: commission.amount,
        currency: commission.currency,
        refType: "Commission",
        refId: commission.id,
        metadata: {
          kind: "compensacion-comision-disponible",
          orderId: order.id,
          orderCode: order.code,
          affiliateId: commission.affiliateId,
          reason: input.reason ?? "reembolso con comisión liberada",
          reversesLedgerEntryId: original?.id ?? null,
        },
      });
      result.compensated.push({ commissionId: commission.id, amount: commission.amount, kind: "reversal" });
    } else {
      // PAID: el dinero ya salió; saldo negativo.
      await tx.commission.update({ where: { id: commission.id }, data: { status: "ADJUSTED" } });
      await appendLedgerEntry(tx, {
        type: "AJUSTE",
        amount: -commission.amount,
        currency: commission.currency,
        refType: "Commission",
        refId: commission.id,
        metadata: {
          kind: COMPENSATION_KIND,
          orderId: order.id,
          orderCode: order.code,
          affiliateId: commission.affiliateId,
          reason: input.reason ?? "reembolso con comisión ya pagada: saldo negativo",
          reversesLedgerEntryId: original?.id ?? null,
        },
      });
      result.compensated.push({ commissionId: commission.id, amount: commission.amount, kind: "negative-balance" });
    }
  }
  return result;
}

/**
 * Resuelve los casos de conciliación `comision-pagada-reembolsada` de un
 * pedido tras compensar (o cuando ya no queda nada que compensar).
 * Devuelve los ids de casos resueltos.
 */
export async function resolvePaidCommissionCases(
  tx: Tx,
  orderId: string,
  resolverId?: string | null,
): Promise<string[]> {
  const cases = await tx.reconciliationCase.findMany({
    where: { status: "ABIERTO" },
    select: { id: true, detail: true },
  });
  const resolved: string[] = [];
  for (const c of cases) {
    const detail = c.detail as { kind?: string; orderId?: string } | null;
    if (detail?.kind !== "comision-pagada-reembolsada" || detail.orderId !== orderId) continue;
    await tx.reconciliationCase.update({
      where: { id: c.id },
      data: { status: "RESUELTO", resolvedAt: new Date(), resolvedById: resolverId ?? null },
    });
    resolved.push(c.id);
  }
  return resolved;
}

// ---------------------------------------------------------------- resumen del afiliado
export type AffiliateSummary = {
  affiliateId: string;
  name: string;
  email: string;
  referralCode: string | null;
  referralLink: string;
  clicks: number;
  sales: number;
  salesTotal: number;
  currency: string;
  balance: AffiliateBalance;
  commissions: { pending: number; retained: number; available: number; paid: number; adjusted: number };
  withdrawals: { requested: number; approved: number; paid: number; rejected: number; totalPaid: number };
  riskStatus: string;
};

export function affiliateReferralLink(referralCode: string | null): string {
  if (!referralCode) return "";
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/r/${referralCode}` : `/r/${referralCode}`;
}

/** Resumen completo del afiliado (perfil + saldos + riesgo). */
export async function getAffiliateSummary(
  client: Client,
  affiliateId: string,
  currency = "DOP",
): Promise<AffiliateSummary | null> {
  const user = await client.user.findUnique({ where: { id: affiliateId } });
  if (!user) return null;
  const [clicks, orders, commissions, withdrawals, fraud] = await Promise.all([
    client.click.count({ where: { affiliateId } }),
    client.order.findMany({
      where: { affiliateId, status: "CONFIRMADO" },
      select: { totalAmount: true, currency: true },
    }),
    client.commission.findMany({ where: { affiliateId }, select: { status: true, amount: true } }),
    client.withdrawal.findMany({ where: { affiliateId }, select: { status: true, amount: true } }),
    client.fraudCase.findFirst({
      where: { entityType: "User", entityId: affiliateId, status: { in: ["REVISION", "RETENIDO", "BLOQUEADO"] } },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    }),
  ]);
  const balance = await getAffiliateBalance(client, affiliateId, currency);
  const byStatus = (rows: Array<{ status: string; amount: number }>, status: string) =>
    rows.filter((r) => r.status === status).reduce((acc, r) => acc + r.amount, 0);
  const countStatus = (rows: Array<{ status: string }>, status: string) =>
    rows.filter((r) => r.status === status).length;
  return {
    affiliateId: user.id,
    name: user.name,
    email: user.email,
    referralCode: user.referralCode,
    referralLink: affiliateReferralLink(user.referralCode),
    clicks,
    sales: orders.length,
    salesTotal: orders.reduce((acc, o) => acc + o.totalAmount, 0),
    currency,
    balance,
    commissions: {
      pending: byStatus(commissions, "PENDING"),
      retained: byStatus(commissions, "RETAINED"),
      available: byStatus(commissions, "AVAILABLE"),
      paid: byStatus(commissions, "PAID"),
      adjusted: byStatus(commissions, "ADJUSTED"),
    },
    withdrawals: {
      requested: countStatus(withdrawals, "REQUESTED"),
      approved: countStatus(withdrawals, "APPROVED"),
      paid: countStatus(withdrawals, "PAID"),
      rejected: countStatus(withdrawals, "REJECTED"),
      totalPaid: byStatus(withdrawals, "PAID"),
    },
    riskStatus: fraud?.status ?? "NORMAL",
  };
}
