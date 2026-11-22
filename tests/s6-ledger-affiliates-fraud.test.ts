// Subfase S6 — Ledger + Afiliados + Fraude (plan §2.3, §2.4, §2.13, §2.14).
// Pruebas: P6 (comisión solo sobre pago confirmado; retención PENDING →
// RETAINED; liberación RETAINED → AVAILABLE; ajuste en reembolso con
// comisión AVAILABLE → compensación sin saldo negativo; con comisión
// PAID → saldo negativo que se absorbe con futuras comisiones), P22
// (reglas de fraude: velocidad, auto-referido, cuentas duplicadas,
// reembolsos repetidos, contracargo → Revisión), retiros (mínimo,
// aprobación, doble aprobación, doble asiento, idempotencia, bloqueo por
// fraude), reportes de ledger (saldos, movimientos por rango, CSV) y
// rutas de conciliación (lista + run con Idempotency-Key).
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { createOrder } from "../src/lib/orders";
import { confirmOrderPayment, refundOrderPayment } from "../src/lib/payments/operations";
import {
  approveWithdrawal,
  compensateRefundedCommissions,
  getAffiliateBalance,
  getMinWithdrawal,
  payWithdrawal,
  requestWithdrawal,
  retainDueCommissions,
} from "../src/lib/affiliates";
import {
  checkPurchaseVelocity,
  detectDuplicateAccounts,
  detectRepeatedRefunds,
  detectSelfReferralAttempt,
  flagForReview,
  handleChargeback,
  holdCommission,
  reviewFraudCase,
  scanRecentOrders,
} from "../src/lib/fraud";
import { getLedgerBalances, getLedgerMovements, ledgerMovementsToCsv } from "../src/lib/ledger";
import { run as retentionRun } from "../src/jobs/commission-retention";
import { run as compensateRun } from "../src/jobs/compensate-paid-commissions";
import { runJobByName } from "../src/lib/jobs";
import { cleanDb, createUser, loginToken } from "./helpers";
import { GET as affiliateMeRoute } from "../src/app/api/affiliates/me/route";
import { GET as affiliateSalesRoute } from "../src/app/api/affiliates/me/sales/route";
import { GET as affiliateWithdrawalsRoute } from "../src/app/api/affiliates/me/withdrawals/route";
import { POST as affiliateWithdrawRoute } from "../src/app/api/affiliates/withdraw/route";
import { GET as adminAffiliatesRoute } from "../src/app/api/admin/affiliates/route";
import { GET as adminWithdrawalsRoute } from "../src/app/api/admin/withdrawals/route";
import { POST as approveRoute } from "../src/app/api/admin/withdrawals/[id]/approve/route";
import { POST as payRoute } from "../src/app/api/admin/withdrawals/[id]/pay/route";
import { GET as fraudCasesRoute, POST as fraudCreateRoute } from "../src/app/api/admin/fraud-cases/route";
import { PATCH as fraudPatchRoute } from "../src/app/api/admin/fraud-cases/[id]/route";
import { GET as reconciliationRoute } from "../src/app/api/admin/reconciliation/route";
import { POST as reconciliationRunRoute } from "../src/app/api/admin/reconciliation/run/route";
import { GET as ledgerBalancesRoute } from "../src/app/api/admin/ledger/balances/route";
import { GET as ledgerMovementsRoute } from "../src/app/api/admin/ledger/movements/route";
import { GET as ledgerExportRoute } from "../src/app/api/admin/ledger/export/route";

// ---------------------------------------------------------------- helpers locales
async function seedManual() {
  const provider = await db.paymentProvider.create({
    data: { code: "MANUAL_TRANSFER", name: "Transferencia manual", type: "MANUAL", status: "OPERATIVO", sandboxMode: false, authorizedForRaffles: true, verifiedAt: new Date() },
  });
  await db.paymentMethod.create({
    data: { code: "MANUAL_TRANSFER", providerId: provider.id, label: "Transferencia bancaria", details: "Banco Popular.", enabled: true },
  });
  return provider;
}

async function makeRaffle(opts: { ticketPrice?: number; totalTickets?: number } = {}) {
  const country = await db.country.upsert({
    where: { code: "DO" },
    update: {},
    create: {
      code: "DO",
      name: "República Dominicana",
      currencyCode: "DOP",
      currencySymbol: "RD$",
      timezone: "America/Santo_Domingo",
      classification: "A",
      status: "ACTIVO",
    },
  });
  const raffle = await db.raffle.create({
    data: {
      title: "Rifa S6",
      description: "Rifa de prueba S6",
      prize: "Premio S6",
      countryId: country.id,
      currency: "DOP",
      ticketPrice: opts.ticketPrice ?? 100,
      totalTickets: opts.totalTickets ?? 100,
      drawAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: "ACTIVA",
    },
  });
  return { raffle, country };
}

async function makeAffiliate(code: string, email: string) {
  return db.user.create({
    data: { name: `Afiliado ${code}`, email, passwordHash: "x", role: "AFILIADO", referralCode: code },
  });
}

let orderCounter = 0;
/** Crea un pedido (PENDIENTE) con afiliado opcional. */
async function makeOrder(opts: { affiliateCode?: string; numbers?: number[]; buyerEmail?: string; ticketPrice?: number } = {}) {
  orderCounter += 1;
  const { raffle } = await makeRaffle({ ticketPrice: opts.ticketPrice ?? 100 });
  const res = await createOrder({
    raffleId: raffle.id,
    buyerName: "Comprador S6",
    buyerEmail: opts.buyerEmail ?? `comprador${orderCounter}@test.do`,
    paymentMethodCode: "MANUAL_TRANSFER",
    numbers: opts.numbers ?? [orderCounter * 2 + 1, orderCounter * 2 + 2],
    affiliateCode: opts.affiliateCode,
    idempotencyKey: `s6-order-${orderCounter}-${Date.now()}`,
  });
  return { raffle, order: res.order };
}

/** Pedido confirmado con afiliado; devuelve pedido + comisión. */
async function makeConfirmedOrder(opts: { affiliateCode?: string; numbers?: number[]; buyerEmail?: string; ticketPrice?: number } = {}) {
  const { raffle, order } = await makeOrder(opts);
  const confirmed = await confirmOrderPayment(order.id, { source: "admin", reference: `REF-${order.code}` });
  const commission = await db.commission.findFirst({ where: { orderId: order.id } });
  return { raffle, order: confirmed.order, commission };
}

/** Mueve una comisión PENDING → RETAINED → AVAILABLE (retención + sweep). */
async function releaseCommission(commissionId: string, raffleId: string) {
  await retainDueCommissions();
  await db.commission.update({
    where: { id: commissionId },
    data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
  });
  await db.raffle.update({ where: { id: raffleId }, data: { drawAt: new Date(Date.now() - 60 * 1000) } });
  const res = await runJobByName("retention-sweep");
  return res;
}

function req(path: string, opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["cookie"] = `pr_session=${opts.token}`;
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, any>>;
}

// ================================================================ P6: comisiones
describe("P6 — comisiones: solo pago confirmado, retención, liberación, ajuste", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("sin pago confirmado no hay comisión; al confirmar, 10% PENDING + asiento COMISION", async () => {
    const affiliate = await makeAffiliate("PRENDE001", "afiliado1@test.do");
    const { order } = await makeOrder({ affiliateCode: "PRENDE001", numbers: [1, 2] }); // 2×100 = 200
    expect(await db.commission.count({ where: { orderId: order.id } })).toBe(0);
    await confirmOrderPayment(order.id, { source: "admin", reference: "REF-1" });
    const commission = await db.commission.findFirstOrThrow({ where: { orderId: order.id } });
    expect(commission.amount).toBe(20); // 10% de 200
    expect(commission.status).toBe("PENDING");
    expect(commission.affiliateId).toBe(affiliate.id);
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { refType: "Commission", refId: commission.id } });
    expect(entry.type).toBe("COMISION");
    expect(entry.amount).toBe(-20);
  });

  it("sin afiliado no hay comisión", async () => {
    const { order } = await makeOrder({ numbers: [1, 2] });
    await confirmOrderPayment(order.id, { source: "admin", reference: "REF-1" });
    expect(await db.commission.count()).toBe(0);
  });

  it("retención: PENDING → RETAINED con el job, idempotente", async () => {
    await makeAffiliate("PRENDE002", "afiliado2@test.do");
    const { commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE002", numbers: [1, 2] });
    expect(commission?.status).toBe("PENDING");
    const r1 = await retentionRun();
    expect(r1.moved).toBe(1);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("RETAINED");
    const r2 = await retentionRun();
    expect(r2.moved).toBe(0);
  });

  it("liberación: RETAINED → AVAILABLE solo tras 7 días y rifa cerrada/sorteo pasado", async () => {
    await makeAffiliate("PRENDE003", "afiliado3@test.do");
    const { raffle, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE003", numbers: [1, 2] });
    await retainDueCommissions();
    // Rifa aún activa y sorteo futuro: no se libera aunque pasen 7 días.
    await db.commission.update({ where: { id: commission!.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });
    const r1 = await runJobByName("retention-sweep");
    expect(r1.result && (r1.result as unknown as { released: number }).released).toBe(0);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("RETAINED");
    // Sorteo ya pasado: se libera.
    await db.raffle.update({ where: { id: raffle.id }, data: { drawAt: new Date(Date.now() - 60 * 1000) } });
    const r2 = await runJobByName("retention-sweep");
    expect(r2.result && (r2.result as unknown as { released: number }).released).toBe(1);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("AVAILABLE");
  });

  it("reembolso con comisión PENDING → ADJUSTED + AJUSTE positivo (S5, sin caso)", async () => {
    await makeAffiliate("PRENDE004", "afiliado4@test.do");
    const { order, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE004", numbers: [1, 2] });
    await refundOrderPayment(order.id, { source: "admin", reason: "test" });
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("ADJUSTED");
    const adj = await db.ledgerEntry.findFirst({ where: { type: "AJUSTE", refType: "Commission", refId: commission!.id } });
    expect(adj?.amount).toBe(20);
    expect(await db.reconciliationCase.count({ where: { status: "ABIERTO" } })).toBe(0);
  });

  it("reembolso con comisión AVAILABLE → compensación sin saldo negativo + caso resuelto", async () => {
    const affiliate = await makeAffiliate("PRENDE005", "afiliado5@test.do");
    const { raffle, order, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE005", numbers: [1, 2] });
    await releaseCommission(commission!.id, raffle.id);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("AVAILABLE");
    await refundOrderPayment(order.id, { source: "admin", reason: "test" });
    // S5 abre el caso comision-pagada-reembolsada.
    const openCase = await db.reconciliationCase.findFirstOrThrow({ where: { status: "ABIERTO" } });
    expect((openCase.detail as { kind: string }).kind).toBe("comision-pagada-reembolsada");
    // El job de S6 compensa y resuelve.
    const res = await compensateRun();
    expect(res.compensated).toBe(1);
    expect(res.casesResolved).toBe(1);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("ADJUSTED");
    const adj = await db.ledgerEntry.findFirstOrThrow({ where: { type: "AJUSTE", refType: "Commission", refId: commission!.id } });
    expect(adj.amount).toBe(20); // reversión positiva: el dinero no salió
    expect((await db.reconciliationCase.findUniqueOrThrow({ where: { id: openCase.id } })).status).toBe("RESUELTO");
    const balance = await getAffiliateBalance(db, affiliate.id);
    expect(balance.available).toBe(0);
    expect(balance.negativeBalance).toBe(0);
    // Idempotente: segunda pasada no compensa nada.
    const res2 = await compensateRun();
    expect(res2.compensated).toBe(0);
  });

  it("reembolso con comisión PAID → saldo negativo que se absorbe con futuras comisiones", async () => {
    const affiliate = await makeAffiliate("PRENDE006", "afiliado6@test.do");
    // Comisión de 500 (1 boleto de 5.000): igual al retiro mínimo.
    const { raffle, order, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE006", numbers: [1], ticketPrice: 5000 });
    expect(commission?.amount).toBe(500);
    await releaseCommission(commission!.id, raffle.id);
    const withdrawal = await requestWithdrawal(affiliate.id, { amount: 500 });
    const admin = await createUser({ role: "FINANZAS", email: "finanzas@test.do" });
    await approveWithdrawal(withdrawal.id, admin.id);
    const paid = await payWithdrawal(withdrawal.id, admin.id, "REC-001");
    expect(paid.withdrawal.status).toBe("PAID");
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("PAID");
    // Reembolso del pedido ya pagado al afiliado.
    await refundOrderPayment(order.id, { source: "admin", reason: "test" });
    await compensateRun();
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("ADJUSTED");
    const adj = await db.ledgerEntry.findFirstOrThrow({ where: { type: "AJUSTE", refType: "Commission", refId: commission!.id } });
    expect(adj.amount).toBe(-500); // saldo negativo
    const balance = await getAffiliateBalance(db, affiliate.id);
    expect(balance.available).toBe(-500);
    expect(balance.negativeBalance).toBe(500);
    // El afiliado no puede retirar con saldo negativo.
    await expect(requestWithdrawal(affiliate.id, { amount: 500 })).rejects.toThrow(/insuficiente/i);
    // Nueva venta: su comisión, al liberarse, absorbe el saldo negativo.
    const second = await makeConfirmedOrder({ affiliateCode: "PRENDE006", numbers: [3], ticketPrice: 5000 });
    await releaseCommission(second.commission!.id, second.raffle.id);
    const balance2 = await getAffiliateBalance(db, affiliate.id);
    expect(balance2.available).toBe(0);
    expect(balance2.negativeBalance).toBe(0);
  });

  it("compensateRefundedCommissions es idempotente por comisión (sin duplicar AJUSTE)", async () => {
    await makeAffiliate("PRENDE007", "afiliado7@test.do");
    const { raffle, order, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE007", numbers: [1, 2] });
    await releaseCommission(commission!.id, raffle.id);
    await refundOrderPayment(order.id, { source: "admin", reason: "test" });
    const r1 = await db.$transaction((tx) => compensateRefundedCommissions(tx, order.id));
    expect(r1.compensated).toHaveLength(1);
    const r2 = await db.$transaction((tx) => compensateRefundedCommissions(tx, order.id));
    expect(r2.compensated).toHaveLength(0);
    expect(r2.alreadyCompensated).toHaveLength(1);
    expect(await db.ledgerEntry.count({ where: { type: "AJUSTE", refType: "Commission", refId: commission!.id } })).toBe(1);
  });
});

// ================================================================ retiros
describe("retiros: mínimo, aprobación, doble aprobación, pago", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  /** Afiliado con saldo AVAILABLE de `amount` (comisión 10% de una venta). */
  async function affiliateWithBalance(code: string, email: string, saleTotal: number) {
    const affiliate = await makeAffiliate(code, email);
    const ticketPrice = saleTotal; // 1 boleto = venta total
    const { raffle, commission } = await makeConfirmedOrder({ affiliateCode: code, numbers: [1], ticketPrice });
    await releaseCommission(commission!.id, raffle.id);
    return { affiliate, commission: commission! };
  }

  it("retiro mínimo: 500 por defecto; por debajo → 400", async () => {
    expect(await getMinWithdrawal()).toBe(500);
    const { affiliate } = await affiliateWithBalance("PRENDE010", "af10@test.do", 10000); // comisión 1.000
    await expect(requestWithdrawal(affiliate.id, { amount: 499 })).rejects.toThrow(/mínimo/i);
    const w = await requestWithdrawal(affiliate.id, { amount: 500 });
    expect(w.status).toBe("REQUESTED");
  });

  it("retiro con saldo insuficiente → 409", async () => {
    const { affiliate } = await affiliateWithBalance("PRENDE011", "af11@test.do", 5000); // comisión 500
    await expect(requestWithdrawal(affiliate.id, { amount: 501 })).rejects.toThrow(/insuficiente/i);
  });

  it("flujo completo: solicitar → aprobar → pagar con doble asiento (RETIRO + comisiones PAID)", async () => {
    const { affiliate, commission } = await affiliateWithBalance("PRENDE012", "af12@test.do", 5000);
    const w = await requestWithdrawal(affiliate.id, { amount: 500 });
    const admin = await createUser({ role: "FINANZAS", email: "fin12@test.do" });
    const approved = await approveWithdrawal(w.id, admin.id);
    expect(approved.fullyApproved).toBe(true);
    expect(approved.withdrawal.status).toBe("APPROVED");
    expect(approved.withdrawal.approvedById).toBe(admin.id);
    const paid = await payWithdrawal(w.id, admin.id, "REC-100");
    expect(paid.withdrawal.status).toBe("PAID");
    expect(paid.commissionsPaid).toContain(commission.id);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission.id } })).status).toBe("PAID");
    const retiro = await db.ledgerEntry.findMany({ where: { type: "RETIRO", refType: "Withdrawal", refId: w.id } });
    expect(retiro).toHaveLength(1);
    expect(retiro[0].amount).toBe(-500);
    const balance = await getAffiliateBalance(db, affiliate.id);
    expect(balance.available).toBe(0);
    expect(balance.paid).toBe(500);
    // Pagar dos veces: idempotente, sin duplicar el asiento.
    const paid2 = await payWithdrawal(w.id, admin.id, "REC-100");
    expect(paid2.alreadyPaid).toBe(true);
    expect(await db.ledgerEntry.count({ where: { type: "RETIRO", refType: "Withdrawal", refId: w.id } })).toBe(1);
  });

  it("pagar sin aprobar → 409; aprobar un retiro pagado devuelve el estado", async () => {
    const { affiliate } = await affiliateWithBalance("PRENDE013", "af13@test.do", 5000);
    const w = await requestWithdrawal(affiliate.id, { amount: 500 });
    const admin = await createUser({ role: "FINANZAS", email: "fin13@test.do" });
    await expect(payWithdrawal(w.id, admin.id)).rejects.toThrow(/APPROVED/);
    await approveWithdrawal(w.id, admin.id);
    await payWithdrawal(w.id, admin.id);
    const again = await approveWithdrawal(w.id, admin.id);
    expect(again.withdrawal.status).toBe("PAID");
  });

  it("doble aprobación: retiro > 10.000 exige dos admins distintos", async () => {
    const { affiliate } = await affiliateWithBalance("PRENDE014", "af14@test.do", 200000); // comisión 20.000
    const w = await requestWithdrawal(affiliate.id, { amount: 20000 });
    const adminA = await createUser({ role: "FINANZAS", email: "finA@test.do" });
    const adminB = await createUser({ role: "SUPERADMIN", email: "supB@test.do" });
    const first = await approveWithdrawal(w.id, adminA.id);
    expect(first.fullyApproved).toBe(false);
    expect(first.approvalsNeeded).toBe(2);
    expect(first.withdrawal.status).toBe("REQUESTED"); // sigue pendiente de la 2ª
    expect(first.withdrawal.approvedById).toBe(adminA.id);
    // El mismo admin no puede dar la segunda aprobación.
    await expect(approveWithdrawal(w.id, adminA.id)).rejects.toThrow(/otro administrador/i);
    // Otro admin sí: queda APPROVED.
    const second = await approveWithdrawal(w.id, adminB.id);
    expect(second.fullyApproved).toBe(true);
    expect(second.withdrawal.status).toBe("APPROVED");
    // Y se puede pagar.
    const paid = await payWithdrawal(w.id, adminB.id, "REC-200");
    expect(paid.withdrawal.status).toBe("PAID");
    // La segunda aprobación quedó en ChangeLog.
    const change = await db.changeLog.findFirst({ where: { entity: "Withdrawal", entityId: w.id, field: "secondApproval" } });
    expect(change?.approvedById).toBe(adminB.id);
  });

  it("aprobar descuenta retiros APPROVED pendientes: no se puede sobregirar", async () => {
    const { affiliate } = await affiliateWithBalance("PRENDE015", "af15@test.do", 10000); // comisión 1.000
    const admin = await createUser({ role: "FINANZAS", email: "fin15@test.do" });
    const w1 = await requestWithdrawal(affiliate.id, { amount: 600 });
    const w2 = await requestWithdrawal(affiliate.id, { amount: 600 });
    await approveWithdrawal(w1.id, admin.id);
    // Quedan 400 disponibles: aprobar el segundo de 600 debe fallar.
    await expect(approveWithdrawal(w2.id, admin.id)).rejects.toThrow(/insuficiente/i);
  });

  it("retiro bloqueado por fraude: ni solicitar ni aprobar", async () => {
    const { affiliate } = await affiliateWithBalance("PRENDE016", "af16@test.do", 5000);
    const w = await requestWithdrawal(affiliate.id, { amount: 500 });
    await flagForReview(db, { rule: "velocity-purchase", reason: "sospechoso", entityType: "User", entityId: affiliate.id });
    await expect(requestWithdrawal(affiliate.id, { amount: 500 })).rejects.toThrow(/fraude/i);
    const admin = await createUser({ role: "FINANZAS", email: "fin16@test.do" });
    await expect(approveWithdrawal(w.id, admin.id)).rejects.toThrow(/fraude/i);
  });
});

// ================================================================ P22: fraude
describe("P22 — fraude: velocidad, auto-referido, duplicados, reembolsos, contracargo", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("velocidad: 5 pedidos en 60 min → flagged; 4 → no", async () => {
    const buyer = "veloz@test.do";
    for (let i = 0; i < 4; i++) {
      await makeOrder({ buyerEmail: buyer, numbers: [i * 2 + 1, i * 2 + 2] });
    }
    const ok = await checkPurchaseVelocity(db, { buyerEmail: buyer });
    expect(ok.flagged).toBe(false);
    expect(ok.orders).toBe(4);
    await makeOrder({ buyerEmail: buyer, numbers: [9, 10] });
    const flagged = await checkPurchaseVelocity(db, { buyerEmail: buyer });
    expect(flagged.flagged).toBe(true);
    expect(flagged.orders).toBe(5);
    expect(flagged.reason).toMatch(/5 pedidos/);
  });

  it("fraud-scan marca velocidad una sola vez (sin duplicar casos)", async () => {
    const buyer = "scan@test.do";
    for (let i = 0; i < 5; i++) {
      await makeOrder({ buyerEmail: buyer, numbers: [i * 2 + 1, i * 2 + 2] });
    }
    const r1 = await scanRecentOrders({ sinceMinutes: 60 });
    expect(r1.flagged).toBeGreaterThanOrEqual(1);
    expect(r1.rules["velocity-purchase"]).toBe(1);
    const cases = await db.fraudCase.findMany({ where: { rule: "velocity-purchase" } });
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe("REVISION");
    const r2 = await scanRecentOrders({ sinceMinutes: 60 });
    expect(await db.fraudCase.count({ where: { rule: "velocity-purchase" } })).toBe(1);
    expect(r2.flagged).toBe(0);
  });

  it("auto-referido: mismo email que el afiliado → caso; distinto email → nada", async () => {
    const affiliate = await makeAffiliate("PRENDE020", "auto@test.do");
    const hit = await detectSelfReferralAttempt(db, {
      orderId: "ord-1",
      affiliateId: affiliate.id,
      buyerEmail: "auto@test.do",
      userId: null,
    });
    expect(hit?.fraudCase.rule).toBe("self-referral-attempt");
    expect(hit?.fraudCase.status).toBe("REVISION");
    const miss = await detectSelfReferralAttempt(db, {
      orderId: "ord-2",
      affiliateId: affiliate.id,
      buyerEmail: "otro@test.do",
      userId: null,
    });
    expect(miss).toBeNull();
    // Sin afiliado no hay auto-referido.
    const none = await detectSelfReferralAttempt(db, { orderId: "ord-3", affiliateId: null, buyerEmail: "x@test.do" });
    expect(none).toBeNull();
  });

  it("múltiples cuentas con el mismo teléfono → caso", async () => {
    const u1 = await createUser({ email: "dup1@test.do" });
    await db.user.update({ where: { id: u1.id }, data: { phone: "8095550001" } });
    const u2 = await createUser({ email: "dup2@test.do" });
    await db.user.update({ where: { id: u2.id }, data: { phone: "8095550001" } });
    const hit = await detectDuplicateAccounts(db, { userId: u2.id, phone: "8095550001" });
    expect(hit?.fraudCase.rule).toBe("duplicate-accounts");
    const miss = await detectDuplicateAccounts(db, { userId: u2.id, phone: "8095559999" });
    expect(miss).toBeNull();
  });

  it("reembolsos repetidos: 2 reembolsos en 90 días → flagged", async () => {
    const buyer = "reemb@test.do";
    for (let i = 0; i < 2; i++) {
      const { order } = await makeOrder({ buyerEmail: buyer, numbers: [i * 2 + 1, i * 2 + 2] });
      await confirmOrderPayment(order.id, { source: "admin", reference: `R-${i}` });
      await refundOrderPayment(order.id, { source: "admin", reason: "test" });
    }
    const res = await detectRepeatedRefunds(db, buyer);
    expect(res.flagged).toBe(true);
    expect(res.refunds).toBe(2);
    const one = await detectRepeatedRefunds(db, "nadie@test.do");
    expect(one.flagged).toBe(false);
  });

  it("contracargo → Revisión: pedido DISPUTADO + casos de fraude (pedido y afiliado) + mueve dinero (S9-int)", async () => {
    await makeAffiliate("PRENDE021", "af21@test.do");
    const { order, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE021", numbers: [1, 2] });
    const res = await handleChargeback({ orderId: order.id, provider: "PAYPAL", providerRef: "CB-1", amount: 200, currency: "DOP", eventId: "evt-1" });
    expect(res.handled).toBe(true);
    expect(res.created).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DISPUTADO");
    const orderCase = await db.fraudCase.findFirstOrThrow({ where: { entityType: "Order", entityId: order.id } });
    expect(orderCase.rule).toBe("chargeback");
    expect(orderCase.status).toBe("REVISION");
    const affiliateCase = await db.fraudCase.findFirst({ where: { entityType: "User", rule: "chargeback" } });
    expect(affiliateCase).not.toBeNull();
    // S9-int: la parte financiera SÍ se mueve (PaymentStatus CONTRACARGO
    // ya existía en el schema; no hubo cambio de schema): el pago pasa a
    // CONTRACARGO, el ledger registra -200 y la comisión PENDING pasa a
    // ADJUSTED con AJUSTE +20.
    expect(res.financial?.moved).toBe(true);
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.status).toBe("CONTRACARGO");
    const cb = await db.ledgerEntry.findFirstOrThrow({ where: { type: "CONTRACARGO" } });
    expect(cb.amount).toBe(-200);
    expect(cb.refId).toBe(order.id);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("ADJUSTED");
    const adj = await db.ledgerEntry.findFirstOrThrow({ where: { type: "AJUSTE", refType: "Commission", refId: commission!.id } });
    expect(adj.amount).toBe(20);
    // Segundo contracargo igual: sin duplicar casos ni asientos.
    const res2 = await handleChargeback({ orderId: order.id, provider: "PAYPAL", providerRef: "CB-1", amount: 200, currency: "DOP", eventId: "evt-1" });
    expect(res2.created).toBe(false);
    expect(res2.financial?.alreadyChargedBack).toBe(true);
    expect(await db.fraudCase.count({ where: { entityType: "Order", entityId: order.id } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { type: "CONTRACARGO" } })).toBe(1);
  });

  it("revisión humana: REVISION → RETENIDO → BLOQUEADO cierra; reabrir solo a REVISION", async () => {
    const { fraudCase } = await flagForReview(db, { rule: "velocity-purchase", reason: "test", entityType: "Order", entityId: "ord-9" });
    const admin = await createUser({ role: "SUPERADMIN", email: "sup@test.do" });
    const held = await reviewFraudCase(fraudCase.id, { riskStatus: "RETENIDO", actorId: admin.id, decision: "retener pago" });
    expect(held.status).toBe("RETENIDO");
    expect(held.resolvedAt).toBeNull();
    const blocked = await reviewFraudCase(fraudCase.id, { riskStatus: "BLOQUEADO", actorId: admin.id, decision: "bloqueado por fraude confirmado" });
    expect(blocked.status).toBe("BLOQUEADO");
    expect(blocked.resolvedAt).not.toBeNull();
    expect(blocked.reviewedById).toBe(admin.id);
    // Cerrado: no se puede saltar a otro estado final sin reabrir.
    await expect(reviewFraudCase(fraudCase.id, { riskStatus: "APROBADO", actorId: admin.id })).rejects.toThrow(/reabrir/);
    const reopened = await reviewFraudCase(fraudCase.id, { riskStatus: "REVISION", actorId: admin.id });
    expect(reopened.status).toBe("REVISION");
    expect(reopened.resolvedAt).toBeNull();
    // Caso inexistente → 404.
    await expect(reviewFraudCase("no-existe", { riskStatus: "APROBADO" })).rejects.toThrow(/no existe/);
  });

  it("holdCommission: AVAILABLE → RETAINED con auditoría", async () => {
    await makeAffiliate("PRENDE022", "af22@test.do");
    const { raffle, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE022", numbers: [1, 2] });
    await releaseCommission(commission!.id, raffle.id);
    const held = await holdCommission(commission!.id, null, "sospecha de fraude");
    expect(held.status).toBe("RETAINED");
    await expect(holdCommission(commission!.id, null, "otra vez")).rejects.toThrow(/AVAILABLE/);
  });
});

// ================================================================ ledger: reportes
describe("ledger: saldos, movimientos por rango, exportación", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("saldos por cuenta tras venta confirmada y reembolso", async () => {
    await makeAffiliate("PRENDE030", "af30@test.do");
    const { order } = await makeConfirmedOrder({ affiliateCode: "PRENDE030", numbers: [1, 2] }); // venta 200, comisión 20
    const balances = await getLedgerBalances(db, { currency: "DOP" });
    expect(balances.ventas).toBe(200);
    expect(balances.comisionesNeto).toBe(-20);
    expect(balances.comisionesPorEstado.PENDING).toBe(20);
    expect(balances.comisionesComprometidas).toBe(20);
    expect(balances.comisionesDisponibles).toBe(0);
    expect(balances.neto).toBe(180);
    expect(balances.movimientos).toBe(2);
    await refundOrderPayment(order.id, { source: "admin", reason: "test" });
    const after = await getLedgerBalances(db, { currency: "DOP" });
    expect(after.ventas).toBe(200);
    expect(after.reembolsos).toBe(-200);
    expect(after.comisionesNeto).toBe(0); // -20 + AJUSTE +20
    expect(after.comisionesPorEstado.ADJUSTED).toBe(20);
    expect(after.neto).toBe(0);
  });

  it("movimientos por rango de fechas y tipo, con paginación", async () => {
    const old = new Date("2026-01-10T12:00:00Z");
    const recent = new Date("2026-11-21T12:00:00Z");
    await db.ledgerEntry.create({ data: { type: "VENTA", amount: 1000, currency: "DOP", refType: "Order", refId: "O-OLD", createdAt: old } });
    await db.ledgerEntry.create({ data: { type: "VENTA", amount: 2000, currency: "DOP", refType: "Order", refId: "O-NEW", createdAt: recent } });
    await db.ledgerEntry.create({ data: { type: "COMISION", amount: -200, currency: "DOP", refType: "Commission", refId: "C-NEW", createdAt: recent } });
    const range = await getLedgerMovements(db, { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-30T23:59:59Z") });
    expect(range.total).toBe(2);
    const ventas = await getLedgerMovements(db, { type: "VENTA" });
    expect(ventas.total).toBe(2);
    const page = await getLedgerMovements(db, { page: 2, limit: 2 });
    expect(page.data).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it("exportación CSV con cabecera y filas", async () => {
    await db.ledgerEntry.create({ data: { type: "VENTA", amount: 1000, currency: "DOP", refType: "Order", refId: "O-1" } });
    const { data } = await getLedgerMovements(db, {});
    const csv = ledgerMovementsToCsv(data);
    expect(csv.startsWith("id,type,amount,currency,refType,refId,createdAt,metadata\n")).toBe(true);
    expect(csv).toContain("VENTA,1000,DOP,Order,O-1");
  });
});

// ================================================================ rutas
describe("rutas S6: afiliado, admin, conciliación, ledger", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("GET /api/affiliates/me: resumen del afiliado; CLIENTE → 403", async () => {
    const affiliate = await makeAffiliate("PRENDE040", "af40@test.do");
    await db.click.create({ data: { affiliateId: affiliate.id, code: "PRENDE040" } });
    const { commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE040", numbers: [1, 2] });
    const token = await loginToken(affiliate);
    const res = await affiliateMeRoute(req("/api/affiliates/me", { token }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.clicks).toBe(1);
    expect(body.sales).toBe(1);
    expect(body.salesTotal).toBe(200);
    expect(body.balance.pending).toBe(20);
    expect(body.referralLink).toContain("/r/PRENDE040");
    expect(body.riskStatus).toBe("NORMAL");
    expect(body.commissions.pending).toBe(20);
    const cliente = await createUser({ role: "CLIENTE", email: "cli@test.do" });
    const res403 = await affiliateMeRoute(req("/api/affiliates/me", { token: await loginToken(cliente) }));
    expect(res403.status).toBe(403);
  });

  it("POST /api/affiliates/withdraw + GET /me/withdrawals + GET /me/sales", async () => {
    const affiliate = await makeAffiliate("PRENDE041", "af41@test.do");
    const { raffle, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE041", numbers: [1], ticketPrice: 5000 });
    await releaseCommission(commission!.id, raffle.id);
    const token = await loginToken(affiliate);
    const bad = await affiliateWithdrawRoute(req("/api/affiliates/withdraw", { method: "POST", token, body: { amount: 100 } }));
    expect(bad.status).toBe(400);
    const ok = await affiliateWithdrawRoute(req("/api/affiliates/withdraw", { method: "POST", token, body: { amount: 500 } }));
    expect(ok.status).toBe(201);
    const okBody = await json(ok);
    expect(okBody.withdrawal.status).toBe("REQUESTED");
    expect(okBody.minWithdrawal).toBe(500);
    const list = await affiliateWithdrawalsRoute(req("/api/affiliates/me/withdrawals", { token }));
    expect((await json(list)).total).toBe(1);
    const sales = await affiliateSalesRoute(req("/api/affiliates/me/sales", { token }));
    const salesBody = await json(sales);
    expect(salesBody.total).toBe(1);
    expect(salesBody.data[0].commission.status).toBe("AVAILABLE");
  });

  it("admin affiliates/withdrawals: FINANZAS ve; AFILIADO → 403", async () => {
    const affiliate = await makeAffiliate("PRENDE042", "af42@test.do");
    await makeConfirmedOrder({ affiliateCode: "PRENDE042", numbers: [1, 2] });
    const finanzas = await createUser({ role: "FINANZAS", email: "fin42@test.do" });
    const finToken = await loginToken(finanzas);
    const res = await adminAffiliatesRoute(req("/api/admin/affiliates", { token: finToken }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.total).toBe(1);
    expect(body.data[0].balance.pending).toBe(20);
    const wRes = await adminWithdrawalsRoute(req("/api/admin/withdrawals", { token: finToken }));
    expect((await json(wRes)).total).toBe(0);
    const affToken = await loginToken(affiliate);
    expect((await adminAffiliatesRoute(req("/api/admin/affiliates", { token: affToken }))).status).toBe(403);
    expect((await adminWithdrawalsRoute(req("/api/admin/withdrawals", { token: affToken }))).status).toBe(403);
  });

  it("rutas approve/pay: flujo por HTTP con Idempotency-Key", async () => {
    const affiliate = await makeAffiliate("PRENDE043", "af43@test.do");
    const { raffle, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE043", numbers: [1], ticketPrice: 5000 });
    await releaseCommission(commission!.id, raffle.id);
    const w = await requestWithdrawal(affiliate.id, { amount: 500 });
    const finanzas = await createUser({ role: "FINANZAS", email: "fin43@test.do" });
    const token = await loginToken(finanzas);
    const approve1 = await approveRoute(
      req(`/api/admin/withdrawals/${w.id}/approve`, { method: "POST", token, headers: { "Idempotency-Key": "appr-1" } }),
      { params: Promise.resolve({ id: w.id }) },
    );
    expect(approve1.status).toBe(200);
    expect((await json(approve1)).withdrawal.status).toBe("APPROVED");
    // Misma clave: misma respuesta, sin duplicar efectos.
    const approve2 = await approveRoute(
      req(`/api/admin/withdrawals/${w.id}/approve`, { method: "POST", token, headers: { "Idempotency-Key": "appr-1" } }),
      { params: Promise.resolve({ id: w.id }) },
    );
    expect((await json(approve2)).withdrawal.status).toBe("APPROVED");
    const pay = await payRoute(
      req(`/api/admin/withdrawals/${w.id}/pay`, { method: "POST", token, body: { receiptRef: "REC-9" } }),
      { params: Promise.resolve({ id: w.id }) },
    );
    expect(pay.status).toBe(200);
    expect((await json(pay)).withdrawal.status).toBe("PAID");
    expect(await db.ledgerEntry.count({ where: { type: "RETIRO", refId: w.id } })).toBe(1);
    // CLIENTE no puede aprobar.
    const cliente = await createUser({ role: "CLIENTE", email: "cli43@test.do" });
    const denied = await approveRoute(
      req(`/api/admin/withdrawals/${w.id}/approve`, { method: "POST", token: await loginToken(cliente) }),
      { params: Promise.resolve({ id: w.id }) },
    );
    expect(denied.status).toBe(403);
  });

  it("fraud-cases: GET lista, POST manual, PATCH revisión (SUPERADMIN)", async () => {
    const admin = await createUser({ role: "SUPERADMIN", email: "sup44@test.do" });
    const token = await loginToken(admin);
    const created = await fraudCreateRoute(req("/api/admin/fraud-cases", { method: "POST", token, body: { rule: "velocity-purchase", reason: "manual", entityType: "Order", entityId: "ord-44" } }));
    expect(created.status).toBe(201);
    const dup = await fraudCreateRoute(req("/api/admin/fraud-cases", { method: "POST", token, body: { rule: "velocity-purchase", reason: "manual", entityType: "Order", entityId: "ord-44" } }));
    expect(dup.status).toBe(200);
    expect((await json(dup)).created).toBe(false);
    const list = await fraudCasesRoute(req("/api/admin/fraud-cases?rule=velocity-purchase", { token }));
    expect((await json(list)).total).toBe(1);
    const caseId = (await json(await fraudCasesRoute(req("/api/admin/fraud-cases", { token })))).data[0].id;
    const patched = await fraudPatchRoute(
      req(`/api/admin/fraud-cases/${caseId}`, { method: "PATCH", token, body: { riskStatus: "BLOQUEADO", decision: "bloqueado" } }),
      { params: Promise.resolve({ id: caseId }) },
    );
    expect(patched.status).toBe(200);
    expect((await json(patched)).data.status).toBe("BLOQUEADO");
    // FINANZAS no tiene fraud.review: 403.
    const fin = await createUser({ role: "FINANZAS", email: "fin44@test.do" });
    const denied = await fraudPatchRoute(
      req(`/api/admin/fraud-cases/${caseId}`, { method: "PATCH", token: await loginToken(fin), body: { riskStatus: "APROBADO" } }),
      { params: Promise.resolve({ id: caseId }) },
    );
    expect(denied.status).toBe(403);
  });

  it("conciliación: GET lista + POST run con Idempotency-Key (un solo JobRun)", async () => {
    await makeAffiliate("PRENDE045", "af45@test.do");
    const { raffle, order, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE045", numbers: [1, 2] });
    await releaseCommission(commission!.id, raffle.id);
    await refundOrderPayment(order.id, { source: "admin", reason: "test" });
    const finanzas = await createUser({ role: "FINANZAS", email: "fin45@test.do" });
    const token = await loginToken(finanzas);
    const list = await reconciliationRoute(req("/api/admin/reconciliation", { token }));
    expect(list.status).toBe(200);
    const listBody = await json(list);
    expect(listBody.total).toBe(1);
    expect(listBody.open).toBe(1);
    const run1 = await reconciliationRunRoute(
      req("/api/admin/reconciliation/run", { method: "POST", token, headers: { "Idempotency-Key": "rec-1" } }),
    );
    expect(run1.status).toBe(200);
    const run1Body = await json(run1);
    expect(run1Body.status).toBe("COMPLETED");
    const jobRunsAfterFirst = await db.jobRun.count({ where: { job: "reconcile-provider" } });
    expect(jobRunsAfterFirst).toBe(1);
    const run2 = await reconciliationRunRoute(
      req("/api/admin/reconciliation/run", { method: "POST", token, headers: { "Idempotency-Key": "rec-1" } }),
    );
    expect((await json(run2)).jobRunId).toBe(run1Body.jobRunId);
    expect(await db.jobRun.count({ where: { job: "reconcile-provider" } })).toBe(1);
    // AUDITOR puede leer pero no ejecutar.
    const auditor = await createUser({ role: "AUDITOR", email: "aud45@test.do" });
    const audToken = await loginToken(auditor);
    expect((await reconciliationRoute(req("/api/admin/reconciliation", { token: audToken }))).status).toBe(200);
    expect((await reconciliationRunRoute(req("/api/admin/reconciliation/run", { method: "POST", token: audToken }))).status).toBe(403);
  });

  it("ledger: balances, movements y export por HTTP", async () => {
    await makeAffiliate("PRENDE046", "af46@test.do");
    await makeConfirmedOrder({ affiliateCode: "PRENDE046", numbers: [1, 2] });
    const finanzas = await createUser({ role: "FINANZAS", email: "fin46@test.do" });
    const token = await loginToken(finanzas);
    const bal = await ledgerBalancesRoute(req("/api/admin/ledger/balances?currency=DOP", { token }));
    expect(bal.status).toBe(200);
    const balBody = await json(bal);
    expect(balBody.ventas).toBe(200);
    expect(balBody.comisionesPorEstado.PENDING).toBe(20);
    const mov = await ledgerMovementsRoute(req("/api/admin/ledger/movements?type=VENTA", { token }));
    expect((await json(mov)).total).toBe(1);
    const exp = await ledgerExportRoute(req("/api/admin/ledger/export", { token }));
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-type")).toContain("text/csv");
    const text = await exp.text();
    expect(text).toContain("VENTA,200,DOP,Order");
    // Sin autenticar → 401.
    expect((await ledgerBalancesRoute(req("/api/admin/ledger/balances"))).status).toBe(401);
  });
});
