// Subfase S10 — Validación final de Fase 1 (plan v2.2 §5.1, pruebas P1–P28).
//
// Este archivo cubre los huecos que el mapa P1–P28 de S10 encontró SIN test
// directo en las subfases anteriores. Las demás P ya tienen test real:
//   P1  tests/s4-orders-tickets.test.ts ("P1: 100 compradores concurrentes…")
//   P2  tests/s5-payments.test.ts ("confirmación manual end-to-end…", 2 boletos
//       VENDIDO + exactamente 1 asiento VENTA + 1 comisión)
//   P4  tests/s5-payments.test.ts ("P4: webhook duplicado (MockProvider)…")
//   P5  tests/s4-orders-tickets.test.ts ("P5: reserva vencida → número liberado…")
//   P6  tests/s5-payments.test.ts ("P4/P6: reembolso…") + tests/s6-… (P6, 8 tests)
//   P7  tests/s7-draw-winner.test.ts ("P7: commit bloqueado…", "P7: execute bloqueado…")
//   P8  tests/s7-draw-winner.test.ts ("P8: segundo commit y segundo execute → 409")
//   P10 tests/s8-notifications-support.test.ts ("P10 — backup restaurado…")
//   P11 tests/rbac.test.ts (matriz 5 tests) + tests/auth.test.ts (login/roles)
//   P13 tests/s3-raffles-countries.test.ts ("cambio de precio CON ventas…", P28)
//   P14 tests/s7-draw-winner.test.ts ("P14: la verificación pública reproduce…")
//       + tests/draw.test.ts (reproducibilidad lib vs script)
//   P15 tests/s3-raffles-countries.test.ts ("P15: POST /api/admin/countries…")
//   P16 tests/s9-integration.test.ts ("GET /api/payment-methods?country=DO…")
//   P18 tests/s3-raffles-countries.test.ts ("P18: gate de activación…")
//   P19 tests/s4-orders-tickets.test.ts ("P19: pago confirmado sin boletos…")
//   P20 tests/s4-orders-tickets.test.ts ("P20: reintento tras caída…")
//   P21 tests/s5-payments.test.ts ("P21: webhook aprobado sin pedido…",
//       "P21: reconcile detecta pago-sin-pedido…")
//   P22 tests/s6-ledger-affiliates-fraud.test.ts ("P22 — fraude…", 8 tests)
//   P23 tests/s7-draw-winner.test.ts ("P23: flujo completo hasta CASO_CERRADO…")
//   P24 tests/s8-notifications-support.test.ts ("P24 — notificación fallida…")
//   P25 tests/s8-notifications-support.test.ts ("P25 — reclamación…") +
//       tests/contract-gaps.test.ts (hueco 1: tickets públicos)
//   P26 tests/s3-raffles-countries.test.ts ("P26 (lib): la aceptación vincula…")
//   P28 tests/s3-raffles-countries.test.ts ("cambio de precio CON ventas +
//       segundo superadmin → 200, ChangeLog antes/después…")
//
// Huecos cerrados AQUÍ (sin test directo antes de S10):
//   P3  failOrderPayment existía (operations.ts) y el webhook de denegación
//       existía (webhooks.ts), pero NINGÚN test los ejercía.
//   P9  sin test: nada verificaba la persistencia tras reinicio.
//   P12 sin test directo: la anulación con motivo existía (tickets.ts) pero
//       no se probaba que un boleto VENDIDO no se pueda modificar salvo anular.
//   P17 sin test: el seam de adaptador existía (registry.ts + MockProvider en
//       S5) pero no se probaba que una pasarela NUEVA se integre como adaptador
//       aislado sin tocar el núcleo.
//   P27 sin test: las monedas se guardaban como snapshot (Order/Payment/
//       LedgerEntry.currency) pero nada verificaba que no se mezclaran ni se
//       reescribieran; el reporte /admin/reports SUMABA monedas distintas en
//       la misma fila (corregido en S10: la clave de grupo incluye la moneda).
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { createOrder } from "../src/lib/orders";
import {
  confirmOrderPayment,
  failOrderPayment,
} from "../src/lib/payments/operations";
import { processWebhookEvent } from "../src/lib/payments/webhooks";
import {
  getAdapter,
  listAdapters,
  type ChargeResult,
  type PaymentProviderAdapter,
  type SandboxTestResult,
} from "../src/lib/payments/registry";
import { getLedgerBalances, ledgerCurrencies } from "../src/lib/ledger";
import { cleanDb, createUser, loginToken, makeRequest } from "./helpers";
import { POST as annulRoute } from "../src/app/api/admin/tickets/[id]/annul/route";
import { GET as reportsRoute } from "../src/app/api/admin/reports/route";

beforeEach(async () => {
  await cleanDb();
});

// Adaptador SOLO para tests (nunca en src/): prueba la maquinaria de
// webhooks/idempotencia sin credenciales reales (igual que el MockProvider
// de S5, pero para el camino de DENEGACIÓN).
const MockProvider: PaymentProviderAdapter = {
  code: "PAYPAL",
  name: "Mock PayPal (solo tests S10)",
  type: "GATEWAY",
  isPreintegrated: false,
  async createCharge(): Promise<ChargeResult> {
    return { status: "APPROVED", providerRef: "MOCK-TXN-S10" };
  },
  async verifyWebhookSignature(_rawBody: string, signature: string): Promise<boolean> {
    return signature === "mock-valid-signature";
  },
  async refund(): Promise<{ ok: boolean; providerRef?: string }> {
    return { ok: true, providerRef: "MOCK-REFUND-S10" };
  },
  async testConnection(): Promise<SandboxTestResult> {
    return { ok: true, provider: "PAYPAL", message: "mock", checkedAt: new Date() };
  },
};

let counter = 0;

async function seedManual() {
  const provider = await db.paymentProvider.upsert({
    where: { code: "MANUAL_TRANSFER" },
    update: { status: "OPERATIVO" },
    create: {
      code: "MANUAL_TRANSFER",
      name: "Transferencia manual",
      type: "MANUAL",
      status: "OPERATIVO",
      sandboxMode: false,
      authorizedForRaffles: true,
      verifiedAt: new Date(),
    },
  });
  await db.paymentMethod.upsert({
    where: { code: "MANUAL_TRANSFER" },
    update: { enabled: true },
    create: {
      code: "MANUAL_TRANSFER",
      providerId: provider.id,
      label: "Transferencia bancaria",
      enabled: true,
    },
  });
  return provider;
}

async function makeRaffle(opts: {
  currency?: string;
  countryCode?: string;
  ticketPrice?: number;
  totalTickets?: number;
} = {}) {
  const currency = opts.currency ?? "DOP";
  const code = opts.countryCode ?? "DO";
  const country = await db.country.upsert({
    where: { code },
    update: {},
    create: {
      code,
      name: code === "DO" ? "República Dominicana" : "Estados Unidos",
      currencyCode: currency,
      currencySymbol: currency === "DOP" ? "RD$" : "US$",
      timezone: "America/Santo_Domingo",
      classification: "A",
      status: "ACTIVO",
    },
  });
  const raffle = await db.raffle.create({
    data: {
      title: `Rifa S10 ${currency}`,
      description: "Rifa de prueba S10",
      prize: "Premio S10",
      countryId: country.id,
      currency,
      ticketPrice: opts.ticketPrice ?? 100,
      totalTickets: opts.totalTickets ?? 100,
      drawAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: "ACTIVA",
    },
  });
  return { raffle, country };
}

async function makePendingOrder(opts: {
  numbers?: number[];
  buyerEmail?: string;
  currency?: string;
  affiliateCode?: string;
} = {}) {
  counter += 1;
  await seedManual();
  const { raffle } = await makeRaffle({ currency: opts.currency });
  let affiliateId: string | undefined;
  if (opts.affiliateCode) {
    const aff = await db.user.create({
      data: {
        name: "Afiliado S10",
        email: `afil-s10-${counter}@test.do`,
        passwordHash: "x",
        role: "AFILIADO",
        referralCode: opts.affiliateCode,
      },
    });
    affiliateId = aff.id;
    await db.click.create({
      data: { affiliateId, raffleId: raffle.id, code: opts.affiliateCode, clickedAt: new Date() },
    });
  }
  const created = await createOrder({
    raffleId: raffle.id,
    buyerName: "Comprador S10",
    buyerEmail: opts.buyerEmail ?? `comprador-s10-${counter}@test.do`,
    paymentMethodCode: "MANUAL_TRANSFER",
    numbers: opts.numbers ?? [7, 8],
    affiliateCode: opts.affiliateCode,
    idempotencyKey: `s10-order-${counter}`,
  });
  return { raffle, order: created.order };
}

async function makeConfirmedOrder(opts: Parameters<typeof makePendingOrder>[0] = {}) {
  const { raffle, order } = await makePendingOrder(opts);
  await confirmOrderPayment(order.id, { source: "admin", reference: `TRF-S10-${counter}`, actorId: null });
  const confirmed = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  return { raffle, order: confirmed };
}

// ------------------------------------------------------------------ P3
describe("S10 — P3: pago rechazado = sin boleto (plan §5.1)", () => {
  it("webhook de denegación → pedido FALLIDO, pago FALLIDO, boletos liberados, sin comisión ni asiento VENTA", async () => {
    const { order } = await makePendingOrder({ numbers: [7, 8], affiliateCode: "AFILP3" });
    const res = await processWebhookEvent({
      provider: "PAYPAL",
      eventId: "evt-denied-1",
      eventType: "payment.denied",
      payload: { id: "evt-denied-1", type: "payment.denied", orderCode: order.code, amount: 200 },
      adapter: MockProvider,
    });
    expect(res.action).toBe("failed");
    expect(res.orderCode).toBe(order.code);

    const after = await db.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: true },
    });
    expect(after.status).toBe("FALLIDO");
    expect(after.payments[0].status).toBe("FALLIDO");
    // Los boletos se liberan Y se desvinculan del pedido (orderId null):
    // el número vuelve a estar disponible para otra compra.
    const freed = await db.ticket.findMany({
      where: { raffleId: order.raffleId, number: { in: [7, 8] } },
    });
    expect(freed.map((t) => t.status)).toEqual(["DISPONIBLE", "DISPONIBLE"]);
    expect(freed.map((t) => t.orderId)).toEqual([null, null]);
    // Sin boleto vendido, sin comisión, sin asiento de venta.
    expect(await db.ticket.count({ where: { orderId: order.id, status: "VENDIDO" } })).toBe(0);
    expect(await db.commission.count({ where: { orderId: order.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { refType: "Order", refId: order.id, type: "VENTA" } })).toBe(0);
  });

  it("el número liberado por un pago fallido se puede volver a comprar", async () => {
    const { raffle, order } = await makePendingOrder({ numbers: [7] });
    await failOrderPayment(order.id, { source: "admin", reason: "tarjeta rechazada" });
    const again = await createOrder({
      raffleId: raffle.id,
      buyerName: "Otro comprador",
      buyerEmail: "otro-s10@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [7],
      idempotencyKey: `s10-retry-${counter}`,
    });
    expect(again.order.status).toBe("PENDIENTE");
    expect(again.tickets.map((t) => t.number)).toEqual([7]);
  });

  it("failOrderPayment es idempotente: segundo llamado devuelve alreadyFailed sin efectos nuevos", async () => {
    const { order } = await makePendingOrder({ numbers: [9] });
    const first = await failOrderPayment(order.id, { source: "admin" });
    expect(first.alreadyFailed).toBe(false);
    const second = await failOrderPayment(order.id, { source: "admin" });
    expect(second.alreadyFailed).toBe(true);
    expect(second.order.status).toBe("FALLIDO");
    expect(await db.auditLog.count({ where: { action: "orders.payment-failed", entityId: order.id } })).toBe(1);
  });
});

// ------------------------------------------------------------------ P9
describe("S10 — P9: reinicio del servidor = sin pérdida de compras confirmadas", () => {
  it("tras desconectar y reconectar Prisma (reinicio simulado), la compra confirmada, los boletos y los saldos siguen intactos", async () => {
    const { order } = await makeConfirmedOrder({ numbers: [11, 12] });
    const before = await db.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: true, tickets: true },
    });
    const balancesBefore = await getLedgerBalances(db, { currency: "DOP" });

    // Reinicio simulado: se cierra el pool de conexiones y se reabre.
    await db.$disconnect();
    await db.$connect();

    const after = await db.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: true, tickets: true },
    });
    expect(after.status).toBe("CONFIRMADO");
    expect(after.payments[0].status).toBe("APROBADO");
    expect(after.tickets.map((t) => t.status)).toEqual(["VENDIDO", "VENDIDO"]);
    expect(after.tickets.map((t) => t.number).sort()).toEqual(
      before.tickets.map((t) => t.number).sort(),
    );
    const balancesAfter = await getLedgerBalances(db, { currency: "DOP" });
    expect(balancesAfter).toEqual(balancesBefore);
    expect(balancesAfter.ventas).toBe(200);
    expect(balancesAfter.movimientos).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ P12
describe("S10 — P12: boleto vendido no se modifica; solo anulación controlada", () => {
  it("anular sin motivo → 400; anular con motivo → ANULADO + refundRequired, sin cambiar número ni comprador; segundo intento → 409", async () => {
    const admin = await createUser({ role: "SUPERADMIN", email: "admin-p12@test.do" });
    const token = await loginToken(admin);
    const { order } = await makeConfirmedOrder({ numbers: [21] });
    const ticket = await db.ticket.findFirstOrThrow({ where: { orderId: order.id } });
    expect(ticket.status).toBe("VENDIDO");

    const noReason = await annulRoute(
      makeRequest(`/api/admin/tickets/${ticket.id}/annul`, { method: "POST", token, body: {} }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(noReason.status).toBe(400);

    const shortReason = await annulRoute(
      makeRequest(`/api/admin/tickets/${ticket.id}/annul`, { method: "POST", token, body: { reason: "no" } }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(shortReason.status).toBe(400);

    const ok = await annulRoute(
      makeRequest(`/api/admin/tickets/${ticket.id}/annul`, {
        method: "POST",
        token,
        body: { reason: "Comprador solicitó devolución, boleto anulado con reembolso." },
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { refundRequired: boolean; refundAmount: number | null };
    expect(body.refundRequired).toBe(true);
    expect(body.refundAmount).toBe(100);

    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("ANULADO");
    expect(after.number).toBe(21); // el número no cambió: solo cambió el estado
    expect(after.buyerName).toBe(ticket.buyerName);
    expect(await db.auditLog.count({ where: { action: "tickets.annul", entityId: ticket.id } })).toBe(1);

    const again = await annulRoute(
      makeRequest(`/api/admin/tickets/${ticket.id}/annul`, {
        method: "POST",
        token,
        body: { reason: "Segundo intento de anulación." },
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(again.status).toBe(409);
  });

  it("bloquear/desbloquear no cambia el número del boleto; un boleto VENDIDO ni siquiera se puede bloquear", async () => {
    const { raffle, order } = await makeConfirmedOrder({ numbers: [22] });
    const sold = await db.ticket.findFirstOrThrow({ where: { orderId: order.id } });
    const { blockTicket, unblockTicket } = await import("../src/lib/tickets");
    const admin = await createUser({ role: "SUPERADMIN", email: "admin-p12b@test.do" });
    // Un boleto VENDIDO no admite bloqueo (ni ningún otro cambio de estado
    // salvo la anulación con motivo): la única vía es anular.
    await expect(blockTicket(sold.id, admin.id, "Intento")).rejects.toThrow(/Solo se puede bloquear/);
    // Un boleto DISPONIBLE sí se bloquea/desbloquea, sin tocar su número.
    // (Los boletos DISPONIBLE solo existen como fila cuando se crean: en
    // este sistema las filas se crean al comprar, así que se crea una
    // directamente para ejercer el camino de bloqueo del admin.)
    const free = await db.ticket.create({
      data: {
        raffleId: raffle.id,
        number: 50,
        code: `S10-FREE-50-${counter}`,
        status: "DISPONIBLE",
      },
    });
    await blockTicket(free.id, admin.id, "Revisión manual");
    const blocked = await db.ticket.findUniqueOrThrow({ where: { id: free.id } });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.number).toBe(free.number);
    await unblockTicket(free.id, admin.id);
    const back = await db.ticket.findUniqueOrThrow({ where: { id: free.id } });
    expect(back.status).toBe("DISPONIBLE");
    expect(back.number).toBe(free.number);
  });
});

// ------------------------------------------------------------------ P17
describe("S10 — P17: nueva pasarela como adaptador aislado (plan §1.5, §2.2)", () => {
  it("un adaptador nuevo implementa la interfaz PaymentProviderAdapter completa y pasa su prueba de sandbox sin tocar el núcleo", async () => {
    // Pasarela nueva (Fase 2, ejemplo): se define como UN módulo aislado que
    // implementa la interfaz; el núcleo (pedidos, ledger, comisiones) no la
    // conoce ni la referencia.
    const NuevoAdapter: PaymentProviderAdapter = {
      code: "MERCADO_PAGO" as PaymentProviderAdapter["code"],
      name: "Mercado Pago (nueva, solo test S10)",
      type: "GATEWAY",
      isPreintegrated: false,
      async createCharge(): Promise<ChargeResult> {
        return { status: "PENDING_PROVIDER", providerRef: "MP-1" };
      },
      async verifyWebhookSignature(_raw, signature): Promise<boolean> {
        return signature === "mp-firma-valida";
      },
      async refund(): Promise<{ ok: boolean; providerRef?: string }> {
        return { ok: true, providerRef: "MP-REF-1" };
      },
      async testConnection(): Promise<SandboxTestResult> {
        return { ok: true, provider: "PAYPAL", message: "sandbox ok", checkedAt: new Date() };
      },
    };

    const charge = await NuevoAdapter.createCharge({
      orderId: "o1",
      orderCode: "PR-1",
      amount: 100,
      currency: "DOP",
      buyerEmail: "c@test.do",
      buyerName: "C",
    });
    expect(charge.status).toBe("PENDING_PROVIDER");
    expect(await NuevoAdapter.verifyWebhookSignature("{}", "mp-firma-valida")).toBe(true);
    expect(await NuevoAdapter.verifyWebhookSignature("{}", "falsa")).toBe(false);
    expect((await NuevoAdapter.refund("MP-1", 100)).ok).toBe(true);
    expect((await NuevoAdapter.testConnection()).ok).toBe(true);

    // El núcleo sigue funcionando sin conocer al adaptador nuevo: el camino
    // de compra/confirmación usa solo MANUAL_TRANSFER (preintegrado).
    const { order } = await makeConfirmedOrder({ numbers: [31] });
    expect(order.status).toBe("CONFIRMADO");

    // Y el registro solo expone los 4 preintegrados: la pasarela nueva NO
    // aparece hasta registrarla (1 entrada en ADAPTERS + su código en
    // ProviderCode, en registry.ts, sin tocar pedidos/ledger/comisiones).
    expect(listAdapters()).toHaveLength(4);
    expect(() => getAdapter("MERCADO_PAGO")).toThrow(/Proveedor desconocido/);
    expect(getAdapter("MANUAL_TRANSFER").code).toBe("MANUAL_TRANSFER");
  });
});

// ------------------------------------------------------------------ P27
describe("S10 — P27: moneda sin recálculo retroactivo (plan §2.9, §5.1)", () => {
  it("cada transacción conserva su moneda y valor originales; los saldos son por moneda; el reporte global no mezcla monedas", async () => {
    const admin = await createUser({ role: "SUPERADMIN", email: "admin-p27@test.do" });
    const token = await loginToken(admin);
    const dop = await makeConfirmedOrder({ numbers: [41, 42] }); // 2 × RD$100
    counter += 1;
    await seedManual();
    const { raffle: usRaffle } = await makeRaffle({
      currency: "USD",
      countryCode: "US",
      ticketPrice: 100,
      totalTickets: 100,
    });
    const usOrder = await createOrder({
      raffleId: usRaffle.id,
      buyerName: "Comprador USD",
      buyerEmail: "usd-s10@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [5],
      idempotencyKey: `s10-usd-${counter}`,
    });
    await confirmOrderPayment(usOrder.order.id, { source: "admin", reference: "TRF-USD-1", actorId: null });

    // Valores originales intactos (snapshot por registro, nunca reescritos).
    const dopOrder = await db.order.findUniqueOrThrow({ where: { id: dop.order.id }, include: { payments: true } });
    expect(dopOrder.currency).toBe("DOP");
    expect(dopOrder.totalAmount).toBe(200);
    expect(dopOrder.payments[0].currency).toBe("DOP");
    const usdOrder = await db.order.findUniqueOrThrow({ where: { id: usOrder.order.id }, include: { payments: true } });
    expect(usdOrder.currency).toBe("USD");
    expect(usdOrder.totalAmount).toBe(100);
    expect(usdOrder.payments[0].currency).toBe("USD");
    const ventaDop = await db.ledgerEntry.findFirstOrThrow({ where: { refType: "Order", refId: dop.order.id, type: "VENTA" } });
    const ventaUsd = await db.ledgerEntry.findFirstOrThrow({ where: { refType: "Order", refId: usOrder.order.id, type: "VENTA" } });
    expect([ventaDop.currency, ventaDop.amount]).toEqual(["DOP", 200]);
    expect([ventaUsd.currency, ventaUsd.amount]).toEqual(["USD", 100]);

    // Saldos por moneda, sin mezclar.
    expect(await ledgerCurrencies(db)).toEqual(["DOP", "USD"]);
    expect((await getLedgerBalances(db, { currency: "DOP" })).ventas).toBe(200);
    expect((await getLedgerBalances(db, { currency: "USD" })).ventas).toBe(100);

    // Reporte global: una fila por moneda (S10 corrige la mezcla en reports).
    const res = await reportsRoute(makeRequest("/api/admin/reports?groupBy=day", { token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ group: string; sales: number; currency: string }>;
    };
    const today = new Date().toISOString().slice(0, 10);
    const rows = body.data.filter((r) => r.group === today);
    expect(rows.map((r) => [r.currency, r.sales]).sort()).toEqual([
      ["DOP", 200],
      ["USD", 100],
    ]);
  });
});
