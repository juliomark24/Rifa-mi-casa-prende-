// Subfase S9-integración — recorrido end-to-end contra el backend real
// (plan v2.2): viaje completo del dinero (registro → compra con afiliado
// → confirmación → comisión → retención → liberación → sorteo commit-reveal
// verificado → ganador publicado → caso cerrado → retiro solicitado →
// aprobado → pagado) + las 4 correcciones de S6 (bloqueo de compras por
// fraude, retention-sweep que salta comisiones con caso abierto, falso
// positivo de reconcile-provider tras reembolso/contracargo, parte
// financiera del contracargo) + rechazo de ventas en rifas no ACTIVAS +
// rutas nuevas (payment-methods, stats, reports, settings) + transiciones
// estrictas del ganador. BD aislada: DATABASE_URL=file:./test-s9.db
// (exportada antes de prisma db push y de vitest; NUNCA prisma/test.db).
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { createOrder } from "../src/lib/orders";
import {
  confirmOrderPayment,
  refundOrderPayment,
} from "../src/lib/payments/operations";
import {
  approveWithdrawal,
  getAffiliateBalance,
  payWithdrawal,
  requestWithdrawal,
  retainDueCommissions,
} from "../src/lib/affiliates";
import {
  flagForReview,
  handleChargeback,
  holdCommission,
  reviewFraudCase,
} from "../src/lib/fraud";
import { commitDraw, executeDraw, verifyDraw } from "../src/lib/draw";
import { advanceWinnerCase } from "../src/lib/winner";
import { runJobByName } from "../src/lib/jobs";
import { run as reconcileRun } from "../src/jobs/reconcile-provider";
import { cleanDb, createUser, loginToken } from "./helpers";
import { GET as publicMethodsRoute } from "../src/app/api/payment-methods/route";
import {
  GET as adminMethodsRoute,
  POST as adminMethodsCreateRoute,
} from "../src/app/api/admin/payment-methods/route";
import { PATCH as adminMethodPatchRoute, DELETE as adminMethodDeleteRoute } from "../src/app/api/admin/payment-methods/[id]/route";
import { GET as statsRoute } from "../src/app/api/admin/stats/route";
import { GET as reportsRoute } from "../src/app/api/admin/reports/route";
import { GET as settingsRoute, PATCH as settingsPatchRoute } from "../src/app/api/admin/settings/route";

// ---------------------------------------------------------------- helpers
async function seedManual() {
  const country = await db.country.upsert({
    where: { code: "DO" },
    update: {},
    create: {
      code: "DO", name: "República Dominicana", currencyCode: "DOP", currencySymbol: "RD$",
      timezone: "America/Santo_Domingo", classification: "A", status: "ACTIVO",
    },
  });
  const provider = await db.paymentProvider.create({
    data: { code: "MANUAL_TRANSFER", name: "Transferencia manual", type: "MANUAL", status: "OPERATIVO", sandboxMode: false, authorizedForRaffles: true, verifiedAt: new Date() },
  });
  const method = await db.paymentMethod.create({
    data: { code: "MANUAL_TRANSFER", providerId: provider.id, label: "Transferencia bancaria", details: "Banco Popular.", enabled: true },
  });
  await db.countryPaymentConfig.create({
    data: { countryId: country.id, providerId: provider.id, methodId: method.id, enabled: true, priority: 1 },
  });
  return provider;
}

async function makeRaffle(opts: { ticketPrice?: number; totalTickets?: number } = {}) {
  const country = await db.country.upsert({
    where: { code: "DO" },
    update: {},
    create: {
      code: "DO", name: "República Dominicana", currencyCode: "DOP", currencySymbol: "RD$",
      timezone: "America/Santo_Domingo", classification: "A", status: "ACTIVO",
    },
  });
  const raffle = await db.raffle.create({
    data: {
      title: "Rifa S9", description: "Rifa de prueba S9", prize: "Premio S9",
      countryId: country.id, currency: "DOP",
      ticketPrice: opts.ticketPrice ?? 100, totalTickets: opts.totalTickets ?? 100,
      drawAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), status: "ACTIVA",
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
async function makeOrder(opts: { affiliateCode?: string; numbers?: number[]; buyerEmail?: string; ticketPrice?: number } = {}) {
  orderCounter += 1;
  const { raffle } = await makeRaffle({ ticketPrice: opts.ticketPrice ?? 100 });
  const res = await createOrder({
    raffleId: raffle.id,
    buyerName: "Comprador S9",
    buyerEmail: opts.buyerEmail ?? `comprador${orderCounter}@test.do`,
    paymentMethodCode: "MANUAL_TRANSFER",
    numbers: opts.numbers ?? [orderCounter * 2 + 1, orderCounter * 2 + 2],
    affiliateCode: opts.affiliateCode,
    idempotencyKey: `s9-order-${orderCounter}-${Date.now()}`,
  });
  return { raffle, order: res.order };
}

async function makeConfirmedOrder(opts: { affiliateCode?: string; numbers?: number[]; buyerEmail?: string; ticketPrice?: number } = {}) {
  const { raffle, order } = await makeOrder(opts);
  const confirmed = await confirmOrderPayment(order.id, { source: "admin", reference: `REF-${order.code}` });
  const commission = await db.commission.findFirst({ where: { orderId: order.id } });
  return { raffle, order: confirmed.order, commission };
}

function req(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
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

const DELIVERY_EVIDENCE = {
  photos: ["https://ejemplo.do/entrega-foto-1.jpg"],
  acta: "Acta de entrega firmada",
  deliveryDate: "2026-11-21",
  responsible: "Admin Prende Rifas",
};

// ================================================== viaje completo del dinero
describe("S9: viaje completo del dinero (registro → compra → sorteo → retiro)", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("invitado con código de afiliado: 10×1000 → comisión 1000 → retención → liberación → sorteo verificado → ganador → retiro pagado", async () => {
    const affiliate = await makeAffiliate("PRENDE_S9", "af-s9@test.do");
    const admin = await createUser({ role: "SUPERADMIN", email: "sup-s9@test.do" });

    // 1. Compra de invitado con código de afiliado (10 boletos × 1000 = 10000).
    const { raffle, order } = await makeOrder({
      affiliateCode: "PRENDE_S9",
      numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      buyerEmail: "invitado-s9@test.do",
      ticketPrice: 1000,
    });
    expect(order.status).toBe("PENDIENTE");
    expect(order.totalAmount).toBe(10000);
    expect(await db.commission.count({ where: { orderId: order.id } })).toBe(0);

    // 2. Confirmación admin (transferencia manual) → comisión 10% PENDING.
    await confirmOrderPayment(order.id, { source: "admin", reference: "REF-S9-1" });
    const commission = await db.commission.findFirstOrThrow({ where: { orderId: order.id } });
    expect(commission.amount).toBe(1000);
    expect(commission.status).toBe("PENDING");
    expect(commission.affiliateId).toBe(affiliate.id);
    const venta = await db.ledgerEntry.findFirstOrThrow({ where: { type: "VENTA", refId: order.id } });
    expect(venta.amount).toBe(10000);
    const comEntry = await db.ledgerEntry.findFirstOrThrow({ where: { type: "COMISION", refType: "Commission", refId: commission.id } });
    expect(comEntry.amount).toBe(-1000);

    // 3. Retención PENDING → RETAINED (job commission-retention).
    await retainDueCommissions();
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission.id } })).status).toBe("RETAINED");

    // 4. Liberación RETAINED → AVAILABLE (retention-sweep, período vencido + sorteo pasado).
    await db.commission.update({
      where: { id: commission.id },
      data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });
    await db.raffle.update({ where: { id: raffle.id }, data: { drawAt: new Date(Date.now() - 60 * 1000) } });
    const sweep = await runJobByName("retention-sweep");
    expect(sweep.result?.ok).toBe(true);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission.id } })).status).toBe("AVAILABLE");
    expect((await getAffiliateBalance(db, affiliate.id)).available).toBe(1000);

    // 5. Sorteo commit-reveal: rifa CERRADA → commit → execute → verificación.
    await db.raffle.update({ where: { id: raffle.id }, data: { status: "CERRADA" } });
    const committed = await commitDraw(raffle.id, admin.id);
    expect(committed.commitment).toMatch(/^[a-f0-9]{64}$/);
    const executed = await executeDraw(raffle.id, admin.id);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).toContain(executed.winnerTicketNumber);
    const draw = await db.draw.findUniqueOrThrow({ where: { raffleId: raffle.id } });
    expect(draw.seed).not.toBeNull(); // executeDraw genera la semilla CSPRNG
    const verification = verifyDraw({
      seed: draw.seed!,
      eligibleSnapshot: draw.eligibleSnapshot,
      commitment: draw.commitment,
      winnerNumber: executed.winnerTicketNumber,
    });
    expect(verification.valid).toBe(true);
    expect(verification.commitmentMatches).toBe(true);
    expect((await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } })).status).toBe("GANADOR_PUBLICADO");

    // 6. Ganador publicado → caso paso a paso hasta CASO_CERRADO (la rifa pasa a FINALIZADA).
    const winnerCase = await db.winnerCase.findFirstOrThrow({ where: { raffleId: raffle.id } });
    expect(winnerCase.status).toBe("PENDIENTE_CONTACTO");
    const winningTicket = await db.ticket.findUniqueOrThrow({ where: { id: winnerCase.winningTicketId! } });
    expect(winningTicket.number).toBe(executed.winnerTicketNumber);
    for (const next of ["CONTACTADO", "VERIFICACION", "PREMIO_ACEPTADO", "ENTREGA_COORDINADA"] as const) {
      const step = await advanceWinnerCase(winnerCase.id, { status: next, note: `Avance a ${next}` });
      expect(step.status).toBe(next);
    }
    await advanceWinnerCase(winnerCase.id, { status: "ENTREGADO", evidence: DELIVERY_EVIDENCE, note: "Premio entregado en mano" });
    const closed = await advanceWinnerCase(winnerCase.id, { status: "CASO_CERRADO", note: "Caso cerrado con acta firmada" });
    expect(closed.status).toBe("CASO_CERRADO");
    expect((await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } })).status).toBe("FINALIZADA");

    // 7. Retiro: solicitado → aprobado (1000 < umbral 10000, una aprobación) → pagado.
    const withdrawal = await requestWithdrawal(affiliate.id, { amount: 1000 });
    expect(withdrawal.status).toBe("REQUESTED");
    const approved = await approveWithdrawal(withdrawal.id, admin.id);
    expect(approved.withdrawal.status).toBe("APPROVED");
    expect(approved.fullyApproved).toBe(true);
    const paid = await payWithdrawal(withdrawal.id, admin.id, "REC-S9-1");
    expect(paid.withdrawal.status).toBe("PAID");
    expect(paid.commissionsPaid).toContain(commission.id);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission.id } })).status).toBe("PAID");
    const retiro = await db.ledgerEntry.findFirstOrThrow({ where: { type: "RETIRO", refId: withdrawal.id } });
    expect(retiro.amount).toBe(-1000);
    expect((await getAffiliateBalance(db, affiliate.id)).available).toBe(0);
  });
});

// ============================================================ correcciones S6
describe("S9: correcciones de S6", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("comprador BLOQUEADO no puede comprar (403); afiliado BLOQUEADO tampoco; al aprobar el caso, la compra pasa", async () => {
    const admin = await createUser({ role: "SUPERADMIN", email: "sup-s9b@test.do" });
    const affiliate = await makeAffiliate("PRENDE_S9B", "af-s9b@test.do");

    // Caso BLOQUEADO sobre el comprador (email).
    const { fraudCase } = await flagForReview(db, {
      rule: "velocity-purchase", reason: "test bloqueo comprador",
      entityType: "Buyer", entityId: "bloqueado@test.do",
    });
    await reviewFraudCase(fraudCase.id, { riskStatus: "BLOQUEADO", actorId: admin.id, decision: "fraude confirmado" });
    await expect(
      makeOrder({ buyerEmail: "bloqueado@test.do", numbers: [1, 2] }),
    ).rejects.toMatchObject({ status: 403, code: "PURCHASE_BLOCKED_FRAUD" });

    // Caso BLOQUEADO sobre el afiliado (User) → la compra con su código también se bloquea.
    const { fraudCase: affCase } = await flagForReview(db, {
      rule: "chargeback", reason: "test bloqueo afiliado",
      entityType: "User", entityId: affiliate.id,
    });
    await reviewFraudCase(affCase.id, { riskStatus: "BLOQUEADO", actorId: admin.id, decision: "fraude confirmado" });
    await expect(
      makeOrder({ affiliateCode: "PRENDE_S9B", buyerEmail: "otro@test.do", numbers: [3, 4] }),
    ).rejects.toMatchObject({ status: 403, code: "PURCHASE_BLOCKED_FRAUD" });

    // Reabrir a REVISION y aprobar → la compra vuelve a pasar (ambos casos).
    for (const c of [fraudCase, affCase]) {
      await reviewFraudCase(c.id, { riskStatus: "REVISION", actorId: admin.id });
      await reviewFraudCase(c.id, { riskStatus: "APROBADO", actorId: admin.id, decision: "falso positivo" });
    }
    const { order } = await makeOrder({ affiliateCode: "PRENDE_S9B", buyerEmail: "bloqueado@test.do", numbers: [5, 6] });
    expect(order.status).toBe("PENDIENTE");
  });

  it("retention-sweep salta la comisión con caso de fraude abierto y la libera cuando el caso se cierra", async () => {
    const admin = await createUser({ role: "SUPERADMIN", email: "sup-s9c@test.do" });
    await makeAffiliate("PRENDE_S9C", "af-s9c@test.do");
    const { raffle, order, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE_S9C", numbers: [1, 2] });
    await retainDueCommissions();
    await db.commission.update({
      where: { id: commission!.id },
      data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });
    await db.raffle.update({ where: { id: raffle.id }, data: { drawAt: new Date(Date.now() - 60 * 1000) } });
    const first = await runJobByName("retention-sweep");
    expect(first.result?.released).toBe(1);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("AVAILABLE");

    // Retención por fraude (AVAILABLE → RETAINED) + caso abierto sobre el pedido.
    await holdCommission(commission!.id, admin.id, "sospecha de fraude");
    const { fraudCase } = await flagForReview(db, {
      rule: "chargeback", reason: "caso abierto sobre el pedido",
      entityType: "Order", entityId: order.id,
    });
    await reviewFraudCase(fraudCase.id, { riskStatus: "RETENIDO", actorId: admin.id, decision: "retener pago" });
    const held = await runJobByName("retention-sweep");
    expect(held.result?.skippedFraudHold).toBe(1);
    expect(held.result?.released).toBe(0);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("RETAINED");

    // Cierre del caso (APROBADO) → el sweep la libera en la siguiente pasada.
    await reviewFraudCase(fraudCase.id, { riskStatus: "APROBADO", actorId: admin.id, decision: "sin fraude" });
    const released = await runJobByName("retention-sweep");
    expect(released.result?.released).toBe(1);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("AVAILABLE");
  });

  it("reconcile-provider no crea venta-sin-confirmacion tras reembolso ni tras contracargo", async () => {
    const { order: refunded } = await makeConfirmedOrder({ numbers: [1, 2] });
    await refundOrderPayment(refunded.id, { source: "admin", reason: "test reembolso" });
    await makeAffiliate("PRENDE_S9D", "af-s9d@test.do");
    const { order: chargedBack } = await makeConfirmedOrder({ affiliateCode: "PRENDE_S9D", numbers: [3, 4] });
    await handleChargeback({ orderId: chargedBack.id, provider: "PAYPAL", providerRef: "CB-S9", amount: 200, currency: "DOP", eventId: "evt-s9" });

    const res = await reconcileRun();
    expect(res.ok).toBe(true);
    // El caso vive en ReconciliationCase.detail (kind/orderId en JSON).
    const openCases = await db.reconciliationCase.findMany({ where: { status: "ABIERTO" } });
    const falsePositives = openCases.filter((c) => {
      const d = c.detail as { kind?: string; orderId?: string } | null;
      return d?.kind === "venta-sin-confirmacion" && (d.orderId === refunded.id || d.orderId === chargedBack.id);
    });
    expect(falsePositives).toHaveLength(0);
  });

  it("contracargo mueve dinero: pago CONTRACARGO + ledger -200 + comisión ADJUSTED + idempotente", async () => {
    await makeAffiliate("PRENDE_S9E", "af-s9e@test.do");
    const { order, commission } = await makeConfirmedOrder({ affiliateCode: "PRENDE_S9E", numbers: [1, 2] });
    const res = await handleChargeback({ orderId: order.id, provider: "PAYPAL", providerRef: "CB-S9E", amount: 200, currency: "DOP", eventId: "evt-s9e" });
    expect(res.financial?.moved).toBe(true);
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("CONTRACARGO");
    expect((await db.ledgerEntry.findFirstOrThrow({ where: { type: "CONTRACARGO" } })).amount).toBe(-200);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission!.id } })).status).toBe("ADJUSTED");
    const res2 = await handleChargeback({ orderId: order.id, provider: "PAYPAL", providerRef: "CB-S9E", amount: 200, currency: "DOP", eventId: "evt-s9e" });
    expect(res2.financial?.alreadyChargedBack).toBe(true);
    expect(await db.ledgerEntry.count({ where: { type: "CONTRACARGO" } })).toBe(1);
  });
});

// ============================================== no-venta-tras-congelamiento
describe("S9: ventas rechazadas en rifas no ACTIVAS (nota S7)", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it.each(["PAUSADA", "CERRADA", "EN_SORTEO", "GANADOR_PUBLICADO", "FINALIZADA", "CANCELADA"] as const)(
    "rifa %s → 409 RAFFLE_NOT_ACTIVE",
    async (status) => {
      const { raffle } = await makeRaffle();
      await db.raffle.update({ where: { id: raffle.id }, data: { status } });
      await expect(
        createOrder({
          raffleId: raffle.id, buyerName: "X", buyerEmail: "x@test.do",
          paymentMethodCode: "MANUAL_TRANSFER", numbers: [1],
          idempotencyKey: `s9-inactive-${status}-${Date.now()}`,
        }),
      ).rejects.toMatchObject({ status: 409, code: "RAFFLE_NOT_ACTIVE" });
    },
  );
});

// ===================================================== rutas nuevas (S9-int)
describe("S9: rutas nuevas del contrato (payment-methods, stats, reports, settings)", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("GET /api/payment-methods?country=DO devuelve el método manual; país desconocido → []", async () => {
    const ok = await json(await publicMethodsRoute(req("/api/payment-methods?country=DO")));
    expect(ok.data).toHaveLength(1);
    expect(ok.data[0].code).toBe("MANUAL_TRANSFER");
    expect(ok.data[0].provider).toBe("MANUAL_TRANSFER");
    const unknown = await json(await publicMethodsRoute(req("/api/payment-methods?country=ZZ")));
    expect(unknown.data).toEqual([]);
  });

  it("admin payment-methods: POST crea (409 si existe / moneda distinta), GET lista, PATCH edita, DELETE borra", async () => {
    const admin = await createUser({ role: "SUPERADMIN", email: "sup-s9f@test.do" });
    const token = await loginToken(admin);
    await db.paymentProvider.create({
      data: { code: "PAYPAL", name: "PayPal", type: "PAYPAL", status: "OPERATIVO", sandboxMode: true, authorizedForRaffles: false },
    });
    const created = await adminMethodsCreateRoute(
      req("/api/admin/payment-methods", { method: "POST", token, body: { country: "DO", currency: "DOP", code: "PAYPAL", label: "PayPal", details: "Pago con PayPal" } }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await json(created)).data as Record<string, any>;
    expect(createdBody.code).toBe("PAYPAL");
    expect(createdBody.country).toBe("DO");
    expect(createdBody.environment).toBe("sandbox");

    const dup = await adminMethodsCreateRoute(
      req("/api/admin/payment-methods", { method: "POST", token, body: { country: "DO", currency: "DOP", code: "PAYPAL", label: "PayPal", details: "x" } }),
    );
    expect(dup.status).toBe(409);
    const badCurrency = await adminMethodsCreateRoute(
      req("/api/admin/payment-methods", { method: "POST", token, body: { country: "DO", currency: "USD", code: "AZUL_CARD", label: "Azul", details: "x" } }),
    );
    expect(badCurrency.status).toBe(409);

    const listed = await json(await adminMethodsRoute(req("/api/admin/payment-methods", { token })));
    expect(listed.data.map((m: { code: string }) => m.code)).toContain("PAYPAL");

    const id = createdBody.id as string;
    const patched = await adminMethodPatchRoute(
      req(`/api/admin/payment-methods/${id}`, { method: "PATCH", token, body: { label: "PayPal (actualizado)" } }),
      { params: Promise.resolve({ id }) },
    );
    expect((await json(patched)).data.label).toBe("PayPal (actualizado)");

    const deleted = await adminMethodDeleteRoute(
      req(`/api/admin/payment-methods/${id}`, { method: "DELETE", token }),
      { params: Promise.resolve({ id }) },
    );
    expect(deleted.status).toBe(200);
    expect(await db.paymentMethod.findUnique({ where: { id } })).toBeNull();
  });

  it("GET /api/admin/stats, /reports y /settings responden con la forma del contrato", async () => {
    const admin = await createUser({ role: "SUPERADMIN", email: "sup-s9g@test.do" });
    const token = await loginToken(admin);
    await makeConfirmedOrder({ numbers: [1, 2] });

    const stats = await json(await statsRoute(req("/api/admin/stats", { token })));
    expect(stats.salesConfirmed).toBe(200);
    expect(stats.totalTicketsSold).toBe(2);
    expect(stats.totalOrders).toBe(1);
    expect(Array.isArray(stats.alerts)).toBe(true);

    const reports = await json(await reportsRoute(req("/api/admin/reports?groupBy=day", { token })));
    expect(reports.data).toHaveLength(1);
    expect(reports.data[0].sales).toBe(200);
    expect(reports.data[0].orders).toBe(1);

    const settings = await json(await settingsRoute(req("/api/admin/settings", { token })));
    const keys = settings.settings.map((s: { key: string }) => s.key);
    expect(keys).toContain("COMMISSION_RATE");
    expect(keys).toContain("RETENTION_DAYS");
    expect(keys).toContain("WITHDRAWAL_DOUBLE_APPROVAL_THRESHOLD");

    const saved = await settingsPatchRoute(
      req("/api/admin/settings", { method: "PATCH", token, body: { settings: [{ key: "RETENTION_DAYS", value: "10" }] } }),
    );
    expect(saved.status).toBe(200);
    expect((await db.setting.findUniqueOrThrow({ where: { key: "RETENTION_DAYS" } })).value).toBe("10");
    const bad = await settingsPatchRoute(
      req("/api/admin/settings", { method: "PATCH", token, body: { settings: [{ key: "RETENTION_DAYS", value: "no-numero" }] } }),
    );
    expect(bad.status).toBe(400);
  });
});

// ============================================== transiciones estrictas ganador
describe("S9: transiciones del ganador — solo el siguiente paso (backend estricto)", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("saltar de PENDIENTE_CONTACTO a VERIFICACION → 409; mismo estado con evidencia sí se permite", async () => {
    const { raffle, order } = await makeConfirmedOrder({ numbers: [1, 2] });
    await db.raffle.update({ where: { id: raffle.id }, data: { status: "CERRADA" } });
    await commitDraw(raffle.id);
    await executeDraw(raffle.id);
    const winnerCase = await db.winnerCase.findFirstOrThrow({ where: { raffleId: raffle.id } });
    expect(winnerCase.status).toBe("PENDIENTE_CONTACTO");
    await expect(
      advanceWinnerCase(winnerCase.id, { status: "VERIFICACION" }),
    ).rejects.toMatchObject({ status: 409 });
    // Mismo estado + evidencia/nota: no-op válido (no avanza).
    const same = await advanceWinnerCase(winnerCase.id, {
      status: "PENDIENTE_CONTACTO",
      note: "Llamada sin respuesta",
      contactChannel: "WHATSAPP",
    });
    expect(same.status).toBe("PENDIENTE_CONTACTO");
    const after = await db.winnerCase.findUniqueOrThrow({ where: { id: winnerCase.id } });
    expect(String(after.notes ?? "")).toContain("Llamada sin respuesta");
    // Cerrar sin evidencia de entrega → 409.
    await advanceWinnerCase(winnerCase.id, { status: "CONTACTADO" });
    await advanceWinnerCase(winnerCase.id, { status: "VERIFICACION" });
    await advanceWinnerCase(winnerCase.id, { status: "PREMIO_ACEPTADO" });
    await advanceWinnerCase(winnerCase.id, { status: "ENTREGA_COORDINADA" });
    await advanceWinnerCase(winnerCase.id, { status: "ENTREGADO" });
    await expect(advanceWinnerCase(winnerCase.id, { status: "CASO_CERRADO" })).rejects.toMatchObject({ status: 409 });
    void order;
  });
});
