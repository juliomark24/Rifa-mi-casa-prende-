// Subfase S5 — Pagos + Conciliación (plan §2.2, §2.11–§2.13).
// Pruebas: P2 (pago aprobado = boleto exactamente una vez), P3
// (confirmación idempotente; pago fallido = sin boleto), P4 (webhook
// duplicado = sin duplicado; reembolso con asiento compensatorio +
// comisión ajustada), P21 (conciliación detecta pago-sin-pedido y
// pedido-sin-pago), expiración de pendiente manual (24 h + aviso 20 h),
// confirmación de transferencia manual end-to-end, webhook con firma
// inválida → 401 sin efectos, método no configurado → 503.
//
// MockProvider: adaptador SOLO para tests (nunca en src/) que prueba la
// maquinaria de webhooks/idempotencia sin credenciales reales. La ruta
// real de webhook se prueba con el adaptador AZUL (HMAC-SHA256) y una
// fila de proveedor OPERATIVO + secreto en credenciales cifradas.
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { createOrder } from "../src/lib/orders";
import { confirmOrderPayment, refundOrderPayment } from "../src/lib/payments/operations";
import { mergeProviderCredentials } from "../src/lib/payments/registry";
import type {
  ChargeResult,
  PaymentProviderAdapter,
  SandboxTestResult,
} from "../src/lib/payments/registry";
import { processWebhookEvent } from "../src/lib/payments/webhooks";
import { JOB_NAME as RECONCILE_JOB, run as reconcileRun } from "../src/jobs/reconcile-provider";
import { JOB_NAME as EXPIRE_JOB, run as expireRun } from "../src/jobs/expire-pending-orders";
import { runJobByName } from "../src/lib/jobs";
import { cleanDb, createUser, loginToken } from "./helpers";
import { POST as confirmRoute } from "../src/app/api/admin/orders/[id]/confirm/route";
import { POST as refundRoute } from "../src/app/api/admin/orders/[id]/refund/route";
import { POST as webhookRoute } from "../src/app/api/payments/webhook/[provider]/route";
import { GET as receiptRoute } from "../src/app/api/orders/[code]/receipt/route";

// ---------------------------------------------------------------- MockProvider (solo tests)
const MockProvider: PaymentProviderAdapter = {
  code: "PAYPAL",
  name: "Mock PayPal (solo tests)",
  type: "GATEWAY",
  isPreintegrated: false,
  async createCharge(): Promise<ChargeResult> {
    return { status: "APPROVED", providerRef: "MOCK-TXN-1" };
  },
  async verifyWebhookSignature(_rawBody: string, signature: string): Promise<boolean> {
    return signature === "mock-valid-signature";
  },
  async refund(): Promise<{ ok: boolean; providerRef?: string }> {
    return { ok: true, providerRef: "MOCK-REFUND-1" };
  },
  async testConnection(): Promise<SandboxTestResult> {
    return { ok: true, provider: "PAYPAL", message: "mock", checkedAt: new Date() };
  },
};

// ---------------------------------------------------------------- helpers locales
async function seedManual() {
  const provider = await db.paymentProvider.create({
    data: { code: "MANUAL_TRANSFER", name: "Transferencia manual", type: "MANUAL", status: "OPERATIVO", sandboxMode: false, authorizedForRaffles: true, verifiedAt: new Date() },
  });
  await db.paymentMethod.create({
    data: { code: "MANUAL_TRANSFER", providerId: provider.id, label: "Transferencia bancaria", details: "Banco Popular, cuenta 123456789, a nombre de Prende Rifas.", enabled: true },
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
      title: "Rifa S5",
      description: "Rifa de prueba S5",
      prize: "Premio S5",
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
async function makeOrder(opts: { affiliateCode?: string; numbers?: number[]; buyerEmail?: string } = {}) {
  orderCounter += 1;
  const { raffle } = await makeRaffle();
  const res = await createOrder({
    raffleId: raffle.id,
    buyerName: "Comprador S5",
    buyerEmail: opts.buyerEmail ?? `comprador${orderCounter}@test.do`,
    paymentMethodCode: "MANUAL_TRANSFER",
    numbers: opts.numbers ?? [7, 8],
    affiliateCode: opts.affiliateCode,
    idempotencyKey: `s5-order-${orderCounter}`,
  });
  return { raffle, order: res.order };
}

function req(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.cookie = `pr_session=${opts.token}`;
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function ledgerCounts(orderId: string) {
  const entries = await db.ledgerEntry.findMany({ where: { refId: orderId } });
  const venta = entries.filter((e) => e.type === "VENTA").length;
  const reembolso = entries.filter((e) => e.type === "REEMBOLSO").length;
  const comisiones = await db.ledgerEntry.findMany({ where: { type: "COMISION" } });
  const ajustes = await db.ledgerEntry.findMany({ where: { type: "AJUSTE" } });
  return { venta, reembolso, comisiones: comisiones.length, ajustes: ajustes.length, entries };
}

describe("S5 pagos", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("nombres de jobs S5 registrados (el runner de S8 los conecta por nombre)", () => {
    expect(RECONCILE_JOB).toBe("reconcile-provider");
    expect(EXPIRE_JOB).toBe("expire-pending-orders");
  });

  it("runner de S8 descubre y ejecuta ambos jobs S5 por nombre (con JobRun)", async () => {
    const rec = await runJobByName("reconcile-provider");
    expect(rec.status).toBe("COMPLETED");
    expect((rec.result as { ok?: boolean } | undefined)?.ok).toBe(true);
    const exp = await runJobByName("expire-pending-orders");
    expect(exp.status).toBe("COMPLETED");
    expect((exp.result as { ok?: boolean } | undefined)?.ok).toBe(true);
    expect(await db.jobRun.count({ where: { job: { in: ["reconcile-provider", "expire-pending-orders"] } } })).toBe(2);
  });

  it("confirmación manual end-to-end: pedido + pago + boletos + VENTA + comisión 10% + notificación", async () => {
    const affiliate = await makeAffiliate("AFIL5", "afil5@test.do");
    const { raffle } = await makeRaffle();
    await db.click.create({
      data: { affiliateId: affiliate.id, raffleId: raffle.id, code: "AFIL5", clickedAt: new Date() },
    });
    const created = await createOrder({
      raffleId: raffle.id,
      buyerName: "Comprador S5",
      buyerEmail: "comprador@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [7, 8],
      affiliateCode: "AFIL5",
      idempotencyKey: "s5-e2e-1",
    });
    const orderId = created.order.id;
    const admin = await createUser({ role: "FINANZAS", email: "finanzas@test.do" });
    const token = await loginToken(admin);

    const res = await confirmRoute(
      req(`/api/admin/orders/${orderId}/confirm`, {
        method: "POST",
        token,
        body: { reference: "TRF-12345", receiptRef: "REC-1" },
        headers: { "Idempotency-Key": "confirm-e2e-1" },
      }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      order: { status: string };
      payment: { status: string; providerRef: string };
      commission: { amount: number; status: string } | null;
      alreadyConfirmed: boolean;
    };
    expect(body.order.status).toBe("CONFIRMADO");
    expect(body.payment.status).toBe("APROBADO");
    expect(body.payment.providerRef).toBe("TRF-12345");
    expect(body.alreadyConfirmed).toBe(false);
    expect(body.commission).not.toBeNull();
    expect(body.commission!.amount).toBe(20); // 10% de 200
    expect(body.commission!.status).toBe("PENDING");

    const tickets = await db.ticket.findMany({ where: { orderId } });
    expect(tickets.map((t) => t.status)).toEqual(["VENDIDO", "VENDIDO"]);
    const counts = await ledgerCounts(orderId);
    expect(counts.venta).toBe(1);
    const ventaEntry = counts.entries.find((e) => e.type === "VENTA");
    expect(ventaEntry!.amount).toBe(200);
    expect(counts.comisiones).toBe(1);
    const comisionEntry = await db.ledgerEntry.findFirst({ where: { type: "COMISION" } });
    expect(comisionEntry!.amount).toBe(-20);
    const notif = await db.notification.findFirst({ where: { event: "pago_confirmado" } });
    expect(notif).not.toBeNull();
    expect(notif!.recipient).toBe("comprador@test.do");
    const comNotif = await db.notification.findFirst({ where: { event: "comision_afiliada" } });
    expect(comNotif).not.toBeNull();
    expect(comNotif!.recipient).toBe("afil5@test.do");
  });

  it("P3: confirmar dos veces (misma y distinta Idempotency-Key) no duplica asientos ni boletos", async () => {
    const { order } = await makeOrder();
    const first = await confirmOrderPayment(order.id, { source: "admin", reference: "TRF-1", actorId: null });
    expect(first.alreadyConfirmed).toBe(false);
    const second = await confirmOrderPayment(order.id, { source: "admin", reference: "TRF-1", actorId: null });
    expect(second.alreadyConfirmed).toBe(true);
    const counts = await ledgerCounts(order.id);
    expect(counts.venta).toBe(1);
    expect(counts.comisiones).toBe(0); // sin afiliado
    const tickets = await db.ticket.findMany({ where: { orderId: order.id } });
    expect(tickets.filter((t) => t.status === "VENDIDO").length).toBe(2);
    const commissions = await db.commission.findMany({ where: { orderId: order.id } });
    expect(commissions.length).toBe(0);
  });

  it("P3: confirmar con otra referencia sobre un pedido ya confirmado → 409", async () => {
    const { order } = await makeOrder();
    await confirmOrderPayment(order.id, { source: "admin", reference: "TRF-1", actorId: null });
    await expect(
      confirmOrderPayment(order.id, { source: "admin", reference: "TRF-OTRA", actorId: null }),
    ).rejects.toMatchObject({ status: 409, code: "REFERENCE_MISMATCH" });
  });

  it("confirmar un pago parcial nunca es venta completa: 409 + caso de conciliación ABIERTO", async () => {
    const { order } = await makeOrder(); // total 200
    await expect(
      confirmOrderPayment(order.id, { source: "admin", reference: "TRF-PARCIAL", amount: 150, actorId: null }),
    ).rejects.toMatchObject({ status: 409, code: "AMOUNT_MISMATCH" });
    const reloaded = await db.order.findUnique({ where: { id: order.id } });
    expect(reloaded!.status).toBe("PENDIENTE");
    const cases = await db.reconciliationCase.findMany({ where: { status: "ABIERTO" } });
    expect(cases.length).toBe(1);
    expect((cases[0].detail as { kind: string }).kind).toBe("monto-distinto");
    expect(await db.ledgerEntry.count()).toBe(0);
  });

  it("confirmar sin permiso → 401 sin sesión, 403 CLIENTE y 403 ADMIN_RIFAS", async () => {
    const { order } = await makeOrder();
    const noAuth = await confirmRoute(
      req(`/api/admin/orders/${order.id}/confirm`, { method: "POST", body: { reference: "X" } }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(noAuth.status).toBe(401);
    const cliente = await createUser({ role: "CLIENTE", email: "cli@test.do" });
    const clienteRes = await confirmRoute(
      req(`/api/admin/orders/${order.id}/confirm`, {
        method: "POST",
        token: await loginToken(cliente),
        body: { reference: "X" },
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(clienteRes.status).toBe(403);
    const rifas = await createUser({ role: "ADMIN_RIFAS", email: "rifas@test.do" });
    const rifasRes = await confirmRoute(
      req(`/api/admin/orders/${order.id}/confirm`, {
        method: "POST",
        token: await loginToken(rifas),
        body: { reference: "X" },
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(rifasRes.status).toBe(403);
  });

  it("P4/P6: reembolso con asiento compensatorio + comisión ajustada + boletos liberados", async () => {
    const affiliate = await makeAffiliate("AFIL6", "afil6@test.do");
    const { raffle } = await makeRaffle();
    await db.click.create({
      data: { affiliateId: affiliate.id, raffleId: raffle.id, code: "AFIL6", clickedAt: new Date() },
    });
    const created = await createOrder({
      raffleId: raffle.id,
      buyerName: "Comprador S5",
      buyerEmail: "comprador6@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [11, 12],
      affiliateCode: "AFIL6",
      idempotencyKey: "s5-refund-1",
    });
    const orderId = created.order.id;
    await confirmOrderPayment(orderId, { source: "admin", reference: "TRF-6", actorId: null });
    const admin = await createUser({ role: "FINANZAS", email: "finanzas6@test.do" });
    const token = await loginToken(admin);
    const res = await refundRoute(
      req(`/api/admin/orders/${orderId}/refund`, {
        method: "POST",
        token,
        body: { reason: "Cliente lo solicitó" },
        headers: { "Idempotency-Key": "refund-6-1" },
      }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      order: { status: string };
      payment: { status: string };
      commissionsAdjusted: { adjusted: Array<{ amount: number }> };
      ticketsReleasedForResale: boolean;
    };
    expect(body.order.status).toBe("REEMBOLSADO");
    expect(body.payment.status).toBe("REEMBOLSADO");
    expect(body.commissionsAdjusted.adjusted.length).toBe(1);
    expect(body.commissionsAdjusted.adjusted[0].amount).toBe(20);
    expect(body.ticketsReleasedForResale).toBe(true);

    const counts = await ledgerCounts(orderId);
    expect(counts.venta).toBe(1); // la VENTA original nunca se borra
    expect(counts.reembolso).toBe(1);
    const reembolsoEntry = counts.entries.find((e) => e.type === "REEMBOLSO");
    expect(reembolsoEntry!.amount).toBe(-200);
    expect(counts.ajustes).toBe(1);
    const ajuste = await db.ledgerEntry.findFirst({ where: { type: "AJUSTE" } });
    expect(ajuste!.amount).toBe(20); // revierte la comisión -20
    const commission = await db.commission.findFirst({ where: { orderId } });
    expect(commission!.status).toBe("ADJUSTED");
    const tickets = await db.ticket.findMany({ where: { raffleId: raffle.id, number: { in: [11, 12] } } });
    expect(tickets.map((t) => t.status)).toEqual(["DISPONIBLE", "DISPONIBLE"]);
    const notif = await db.notification.findFirst({ where: { event: "reembolso" } });
    expect(notif).not.toBeNull();

    // Reembolsar dos veces: idempotente, sin duplicar asientos.
    const again = await refundOrderPayment(orderId, { source: "admin", reason: "otra vez" });
    expect(again.alreadyRefunded).toBe(true);
    const counts2 = await ledgerCounts(orderId);
    expect(counts2.reembolso).toBe(1);
    expect(counts2.ajustes).toBe(1);
  });

  it("reembolso de pedido PENDIENTE → 400 (no hay cobro que devolver)", async () => {
    const { order } = await makeOrder();
    await expect(
      refundOrderPayment(order.id, { source: "admin", reason: "x" }),
    ).rejects.toMatchObject({ status: 400, code: "REFUND_NOTHING_TO_REFUND" });
    const reloaded = await db.order.findUnique({ where: { id: order.id } });
    expect(reloaded!.status).toBe("PENDIENTE");
  });

  it("P4: webhook duplicado (MockProvider) → un solo efecto", async () => {
    const { order } = await makeOrder();
    const payload = {
      id: "evt-dup-1",
      type: "payment.approved",
      orderCode: order.code,
      providerRef: "MOCK-TXN-1",
      amount: 200,
    };
    const first = await processWebhookEvent({
      provider: "PAYPAL",
      eventId: "evt-dup-1",
      eventType: "payment.approved",
      payload,
      adapter: MockProvider,
    });
    expect(first.received).toBe(true);
    expect(first.action).toBe("confirmed");
    expect(first.duplicate).toBeUndefined();
    const second = await processWebhookEvent({
      provider: "PAYPAL",
      eventId: "evt-dup-1",
      eventType: "payment.approved",
      payload,
      adapter: MockProvider,
    });
    expect(second.duplicate).toBe(true);
    const counts = await ledgerCounts(order.id);
    expect(counts.venta).toBe(1);
    const reloaded = await db.order.findUnique({ where: { id: order.id } });
    expect(reloaded!.status).toBe("CONFIRMADO");
    const events = await db.webhookEvent.findMany({ where: { provider: "PAYPAL", eventId: "evt-dup-1" } });
    expect(events.length).toBe(1);
    expect(events[0].processedAt).not.toBeNull();
  });

  it("P21: webhook aprobado sin pedido → caso pago-sin-pedido, sin inventar venta", async () => {
    const result = await processWebhookEvent({
      provider: "PAYPAL",
      eventId: "evt-huerfano-1",
      eventType: "payment.approved",
      payload: { id: "evt-huerfano-1", type: "payment.approved", orderCode: "ORD-INEXISTENTE", providerRef: "MOCK-TXN-99", amount: 500 },
      adapter: MockProvider,
    });
    expect(result.action).toBe("case-pago-sin-pedido");
    expect(result.caseId).not.toBeNull();
    expect(await db.order.count()).toBe(0);
    expect(await db.ledgerEntry.count()).toBe(0);
    const c = await db.reconciliationCase.findUnique({ where: { id: result.caseId! } });
    expect(c!.status).toBe("ABIERTO");
    expect((c!.detail as { kind: string }).kind).toBe("pago-sin-pedido");
  });

  it("P21: reconcile detecta pago-sin-pedido y pedido-sin-pago; segunda pasada no duplica casos", async () => {
    // Pago APROBADO sin pedido confirmado ni boletos vendidos.
    const { order: orderA } = await makeOrder({ numbers: [21] });
    await db.payment.updateMany({ where: { orderId: orderA.id }, data: { status: "APROBADO" } });
    // Pedido CONFIRMADO sin pago aprobado.
    const { order: orderB } = await makeOrder({ numbers: [22] });
    await db.order.update({ where: { id: orderB.id }, data: { status: "CONFIRMADO" } });
    await db.ticket.updateMany({ where: { orderId: orderB.id }, data: { status: "VENDIDO" } });

    const first = await reconcileRun(new Date());
    expect(first.ok).toBe(true);
    expect(first.casesCreated).toBeGreaterThanOrEqual(2);
    const kinds = (await db.reconciliationCase.findMany({ where: { status: "ABIERTO" } })).map(
      (c) => (c.detail as { kind: string }).kind,
    );
    expect(kinds).toContain("pago-sin-boletos");
    expect(kinds).toContain("pedido-sin-pago");

    const second = await reconcileRun(new Date());
    expect(second.casesCreated).toBe(0);
    expect(second.casesAlreadyOpen).toBeGreaterThanOrEqual(2);
    expect(await db.reconciliationCase.count({ where: { status: "ABIERTO" } })).toBe(
      await db.reconciliationCase.count(),
    );
  });

  it("reconcile: proveedor sin credenciales queda NO_CONCILIABLE sin inventar datos", async () => {
    await db.paymentProvider.create({
      data: { code: "PAYPAL", name: "PayPal", type: "GATEWAY", status: "NO_OPERATIVO", sandboxMode: true },
    });
    const result = await reconcileRun(new Date());
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].provider).toBe("PAYPAL");
    expect(result.providers[0].conciliable).toBe(false);
    const cases = await db.reconciliationCase.findMany();
    const noConc = cases.find((c) => (c.detail as { kind?: string }).kind === "no-conciliable");
    expect(noConc).toBeDefined();
    expect(noConc!.status).toBe("ABIERTO");
  });

  it("expiración manual: aviso a las 20 h y expiración a las 24 h (sin tocar reservas)", async () => {
    const { order: oldOrder, raffle: oldRaffle } = await makeOrder({ numbers: [31], buyerEmail: "viejo@test.do" });
    await db.order.update({
      where: { id: oldOrder.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const { order: warnOrder } = await makeOrder({ numbers: [32], buyerEmail: "aviso@test.do" });
    await db.order.update({
      where: { id: warnOrder.id },
      data: { createdAt: new Date(Date.now() - 21 * 60 * 60 * 1000) },
    });

    const result = await expireRun(new Date());
    expect(result.warned).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.warnedOrderCodes).toContain(warnOrder.code);
    expect(result.expiredOrderCodes).toContain(oldOrder.code);

    const warnedNotif = await db.notification.findFirst({
      where: { event: "pedido_por_vencer", recipient: "aviso@test.do" },
    });
    expect(warnedNotif).not.toBeNull();
    const stillPending = await db.order.findUnique({ where: { id: warnOrder.id } });
    expect(stillPending!.status).toBe("PENDIENTE");

    const expired = await db.order.findUnique({ where: { id: oldOrder.id }, include: { payments: true } });
    expect(expired!.status).toBe("EXPIRADO");
    // Los boletos liberados se desvinculan del pedido (orderId null, como
    // en cancelOrder): se verifican por rifa + número.
    const freed = await db.ticket.findMany({
      where: { raffleId: oldRaffle.id, number: 31 },
    });
    expect(freed.map((t) => t.status)).toEqual(["DISPONIBLE"]);
    expect(freed[0].orderId).toBeNull();
    expect(expired!.payments[0].status).toBe("FALLIDO");

    // Segunda pasada: idempotente (sin segundo aviso ni segunda expiración).
    const again = await expireRun(new Date());
    expect(again.warned).toBe(0);
    expect(again.expired).toBe(0);
    expect(await db.notification.count({ where: { event: "pedido_por_vencer" } })).toBe(1);
  });

  it("webhook ruta: firma inválida → 401 sin efectos; firma válida HMAC → 200 y confirma", async () => {
    const secret = "azul-webhook-secret-test";
    const { encrypted } = mergeProviderCredentials(null, { webhookSecret: secret });
    await db.paymentProvider.create({
      data: {
        code: "AZUL",
        name: "Azul (Banco Popular)",
        type: "GATEWAY",
        status: "OPERATIVO",
        sandboxMode: true,
        credentialsEncrypted: encrypted,
        credentialsRef: "panel:webhookSecret",
        authorizedForRaffles: true,
      },
    });
    const { order } = await makeOrder();
    const payload = JSON.stringify({
      id: "evt-azul-1",
      type: "payment.approved",
      orderCode: order.code,
      providerRef: "AZUL-TXN-9",
      amount: 200,
    });
    const badSig = await webhookRoute(
      req("/api/payments/webhook/azul", {
        method: "POST",
        headers: { "x-signature": "00".repeat(32) },
        body: JSON.parse(payload),
      }),
      { params: Promise.resolve({ provider: "azul" }) },
    );
    // Nota: NextRequest con body JSON re-serializa; la firma se calcula
    // sobre el cuerpo que recibe la ruta, así que el 401 aquí también
    // cubre "cuerpo distinto al firmado". El caso válido usa el cuerpo
    // exacto que la ruta lee (ver abajo con raw body vía Request).
    expect(badSig.status).toBe(401);
    const untouched = await db.order.findUnique({ where: { id: order.id } });
    expect(untouched!.status).toBe("PENDIENTE");

    // Firma válida: se firma el cuerpo exacto que la ruta leerá.
    const rawBody = JSON.stringify({
      id: "evt-azul-2",
      type: "payment.approved",
      orderCode: order.code,
      providerRef: "AZUL-TXN-10",
      amount: 200,
    });
    const goodSig = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const rawReq = new NextRequest(new URL("http://localhost/api/payments/webhook/azul"), {
      method: "POST",
      headers: { "x-signature": goodSig, "content-type": "application/json" },
      body: rawBody,
    });
    const good = await webhookRoute(rawReq, { params: Promise.resolve({ provider: "azul" }) });
    expect(good.status).toBe(200);
    const goodBody = (await good.json()) as { action?: string };
    expect(goodBody.action).toBe("confirmed");
    const confirmed = await db.order.findUnique({ where: { id: order.id }, include: { payments: true } });
    expect(confirmed!.status).toBe("CONFIRMADO");
    expect(confirmed!.payments[0].providerRef).toBe("AZUL-TXN-10");
  });

  it("método no configurado → 503: webhook PayPal sin proveedor operativo y compra PayPal", async () => {
    const res = await webhookRoute(
      req("/api/payments/webhook/paypal", { method: "POST", body: { id: "x", type: "payment.approved" } }),
      { params: Promise.resolve({ provider: "paypal" }) },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("NOT_CONFIGURED");
    const unknown = await webhookRoute(
      req("/api/payments/webhook/stripe", { method: "POST", body: {} }),
      { params: Promise.resolve({ provider: "stripe" }) },
    );
    expect(unknown.status).toBe(404);
  });

  it("receipt: PDF binario real por defecto; ?format=json mantiene el JSON anterior", async () => {
    const { order } = await makeOrder();
    const pdfRes = await receiptRoute(
      req(`/api/orders/${order.code}/receipt`),
      { params: Promise.resolve({ code: order.code }) },
    );
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toContain("application/pdf");
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.toString("latin1")).toContain(order.code);

    const jsonRes = await receiptRoute(
      req(`/api/orders/${order.code}/receipt?format=json`),
      { params: Promise.resolve({ code: order.code }) },
    );
    expect(jsonRes.status).toBe(200);
    const jsonBody = (await jsonRes.json()) as { qrCode: string; qrPayload: string };
    expect(jsonBody.qrCode.startsWith("data:image/png;base64,")).toBe(true);
    expect(jsonBody.qrPayload).toContain(order.code);
  });
});
