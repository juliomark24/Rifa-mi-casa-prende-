// Subfase S4 — Pedidos + Boletos + Reservas (plan §2.1, §2.11, §2.12).
// Pruebas: P1 (concurrencia por el mismo número), P5 (reserva vencida),
// P19 (pago confirmado sin boletos), P20 (reintento / webhook 3x),
// idempotencia de pedido, anulación con motivo, atribución de afiliado,
// compra invitada y límites por compra/cliente, endpoints S4.
//
// NOTA DE ALCANCE DE P1: SQLite serializa las escrituras (better-sqlite3),
// así que la "concurrencia real" aquí es 100 llamadas simultáneas sobre
// la misma función con el mismo motor que usa el resto de la suite. La
// garantía en PostgreSQL es la misma lógica (transacción + constraint
// único [raffleId, number] + conversión de P2002 a 409), pero el
// comportamiento bajo contención real de Postgres queda para S10/entorno
// con Postgres.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { createReservation, releaseExpiredReservations } from "../src/lib/reservations";
import {
  cancelOrder,
  createOrder,
  recoverConfirmedPaymentWithoutTickets,
  resolveAffiliate,
} from "../src/lib/orders";
import { annulTicket, blockTicket, getAvailability, unblockTicket, verifyTicket } from "../src/lib/tickets";
import { JOB_NAME, run as releaseJobRun } from "../src/jobs/release-expired-reservations";
import { cleanDb, createUser, loginToken } from "./helpers";
import { POST as reserveRoute } from "../src/app/api/raffles/[id]/reserve/route";
import { POST as purchaseRoute } from "../src/app/api/raffles/[id]/purchase/route";
import { GET as orderRoute } from "../src/app/api/orders/[code]/route";
import { GET as mineRoute } from "../src/app/api/orders/mine/route";
import { GET as receiptRoute } from "../src/app/api/orders/[code]/receipt/route";
import { GET as verifyRoute } from "../src/app/api/tickets/verify/route";
import { GET as adminOrdersRoute } from "../src/app/api/admin/orders/route";
import { POST as adminCancelRoute } from "../src/app/api/admin/orders/[id]/cancel/route";
import { GET as adminTicketsRoute } from "../src/app/api/admin/tickets/route";

async function seedManual() {
  const provider = await db.paymentProvider.create({
    data: { code: "MANUAL_TRANSFER", name: "Transferencia manual", type: "MANUAL", status: "OPERATIVO", sandboxMode: false, authorizedForRaffles: true, verifiedAt: new Date() },
  });
  await db.paymentMethod.create({
    data: { code: "MANUAL_TRANSFER", providerId: provider.id, label: "Transferencia bancaria", details: "Banco Popular, cuenta 123456789, a nombre de Prende Rifas.", enabled: true },
  });
  return provider;
}

async function makeRaffle(opts: { totalTickets?: number; maxPerPurchase?: number | null; maxPerCustomer?: number | null; status?: "ACTIVA" | "PAUSADA" | "BORRADOR"; ticketPrice?: number } = {}) {
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
      title: "Rifa S4",
      description: "Rifa de prueba S4",
      prize: "Premio S4",
      countryId: country.id,
      currency: "DOP",
      ticketPrice: opts.ticketPrice ?? 100,
      totalTickets: opts.totalTickets ?? 100,
      drawAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: opts.status ?? "ACTIVA",
      maxTicketsPerPurchase: opts.maxPerPurchase ?? null,
      maxTicketsPerCustomer: opts.maxPerCustomer ?? null,
    },
  });
  const terms = await db.raffleTerms.create({
    data: { raffleId: raffle.id, version: 1, content: "Bases v1 de prueba S4." },
  });
  await db.raffle.update({ where: { id: raffle.id }, data: { termsVersionId: terms.id } });
  return { raffle, terms, country };
}

async function makeAffiliate(code: string, email: string) {
  return db.user.create({
    data: {
      name: `Afiliado ${code}`,
      email,
      passwordHash: "x",
      role: "AFILIADO",
      referralCode: code,
    },
  });
}

function req(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; idempotencyKey?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.cookie = `pr_session=${opts.token}`;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("S4 reservas", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("P1: 100 compradores concurrentes por el mismo número → solo uno lo obtiene", async () => {
    const { raffle } = await makeRaffle({ totalTickets: 100 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        createReservation({
          raffleId: raffle.id,
          buyerEmail: `comprador${i}@test.do`,
          numbers: [7],
          idempotencyKey: `p1-key-${i}`,
        }),
      ),
    );
    const won = attempts.filter((a) => a.status === "fulfilled");
    const lost = attempts.filter((a) => a.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(99);
    for (const l of lost) {
      expect((l as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }
    const tickets = await db.ticket.findMany({ where: { raffleId: raffle.id, number: 7 } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].status).toBe("RESERVADO");
    const reservations = await db.reservation.findMany({ where: { raffleId: raffle.id } });
    expect(reservations).toHaveLength(1);
    expect(reservations[0].status).toBe("ACTIVA");
  });

  it("número ocupado → 409 con sugerencia de números cercanos", async () => {
    const { raffle } = await makeRaffle({ totalTickets: 100 });
    await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [50], idempotencyKey: "k-a" });
    await expect(
      createReservation({ raffleId: raffle.id, buyerEmail: "b@test.do", numbers: [50], idempotencyKey: "k-b" }),
    ).rejects.toMatchObject({ status: 409 });
    try {
      await createReservation({ raffleId: raffle.id, buyerEmail: "b@test.do", numbers: [50], idempotencyKey: "k-b2" });
      expect.unreachable("debió fallar con 409");
    } catch (err) {
      expect((err as Error).message).toMatch(/cercanos/);
      expect((err as Error).message).toMatch(/51|49/);
    }
  });

  it("quantity asigna números aleatorios entre disponibles, sin repetir", async () => {
    const { raffle } = await makeRaffle({ totalTickets: 10 });
    const res = await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", quantity: 5, idempotencyKey: "k-q" });
    expect(res.numbers).toHaveLength(5);
    expect(new Set(res.numbers).size).toBe(5);
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const res2 = await createReservation({ raffleId: raffle.id, buyerEmail: "b@test.do", quantity: 5, idempotencyKey: "k-q2" });
    expect(res2.numbers).toHaveLength(5);
    expect(res2.numbers.filter((n) => res.numbers.includes(n))).toHaveLength(0);
    await expect(
      createReservation({ raffleId: raffle.id, buyerEmail: "c@test.do", quantity: 1, idempotencyKey: "k-q3" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("misma Idempotency-Key de reserva → misma reserva, sin duplicar", async () => {
    const { raffle } = await makeRaffle();
    const first = await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [3], idempotencyKey: "dup-1" });
    const second = await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [3], idempotencyKey: "dup-1" });
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.reused).toBe(true);
    expect(await db.reservation.count()).toBe(1);
    expect(await db.ticket.count({ where: { raffleId: raffle.id } })).toBe(1);
  });

  it("rifa no activa → 409; número fuera de rango → 400", async () => {
    const { raffle } = await makeRaffle({ status: "PAUSADA" });
    await expect(
      createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [1], idempotencyKey: "k-p" }),
    ).rejects.toMatchObject({ status: 409 });
    const { raffle: active } = await makeRaffle({ totalTickets: 10 });
    await expect(
      createReservation({ raffleId: active.id, buyerEmail: "a@test.do", numbers: [11], idempotencyKey: "k-r" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("P5: reserva vencida → número liberado + registro; re-ejecutar no duplica", async () => {
    const { raffle } = await makeRaffle();
    const res = await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [9, 10], idempotencyKey: "k-exp" });
    // Vence la reserva (simula el paso de los ~10 min).
    await db.reservation.update({ where: { id: res.reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const first = await releaseExpiredReservations();
    expect(first.released).toBe(1);
    expect(first.ticketsReleased).toBe(2);
    expect(first.reservationIds).toContain(res.reservationId);
    const reservation = await db.reservation.findUnique({ where: { id: res.reservationId } });
    expect(reservation?.status).toBe("VENCIDA");
    const tickets = await db.ticket.findMany({ where: { raffleId: raffle.id } });
    expect(tickets.every((t) => t.status === "DISPONIBLE")).toBe(true);
    const audit = await db.auditLog.findFirst({ where: { action: "reservations.release-expired", entityId: res.reservationId } });
    expect(audit).not.toBeNull();
    // Idempotencia del job: segunda ejecución no libera nada más.
    const second = await releaseExpiredReservations();
    expect(second.released).toBe(0);
    expect(second.ticketsReleased).toBe(0);
    expect(await db.auditLog.count({ where: { action: "reservations.release-expired", entityId: res.reservationId } })).toBe(1);
    // El número vuelve a estar disponible para otro comprador.
    const res2 = await createReservation({ raffleId: raffle.id, buyerEmail: "b@test.do", numbers: [9], idempotencyKey: "k-exp2" });
    expect(res2.numbers).toEqual([9]);
  });

  it("el job release-expired-reservations expone JOB_NAME y run()", async () => {
    expect(JOB_NAME).toBe("release-expired-reservations");
    const { raffle } = await makeRaffle();
    const res = await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [1], idempotencyKey: "k-job" });
    await db.reservation.update({ where: { id: res.reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const out = await releaseJobRun();
    expect(out.released).toBe(1);
    expect(out.ok).toBe(true);
  });

  it("límites por compra y por cliente", async () => {
    const { raffle } = await makeRaffle({ totalTickets: 50, maxPerPurchase: 2, maxPerCustomer: 3 });
    await expect(
      createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [1, 2, 3], idempotencyKey: "k-l1" }),
    ).rejects.toMatchObject({ status: 409 });
    await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [1, 2], idempotencyKey: "k-l2" });
    await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [3], idempotencyKey: "k-l3" });
    await expect(
      createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [4], idempotencyKey: "k-l4" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("S4 pedidos", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  async function buyWithReservation(email = "cliente@test.do", numbers = [5, 6, 7], key = "order-1") {
    const { raffle, terms } = await makeRaffle({ ticketPrice: 100 });
    const res = await createReservation({ raffleId: raffle.id, buyerEmail: email, numbers, idempotencyKey: `res-${key}` });
    const order = await createOrder({
      raffleId: raffle.id,
      buyerName: "Cliente Test",
      buyerEmail: email,
      buyerPhone: "8095550100",
      paymentMethodCode: "MANUAL_TRANSFER",
      reservationId: res.reservationId,
      idempotencyKey: key,
    });
    return { raffle, terms, reservation: res, order };
  }

  it("compra con reserva: Order PENDIENTE + Payment PENDIENTE + tickets RESERVADO + instrucciones + bases", async () => {
    const { raffle, order } = await buyWithReservation();
    expect(order.created).toBe(true);
    expect(order.order.status).toBe("PENDIENTE");
    expect(order.order.totalAmount).toBe(300);
    expect(order.order.currency).toBe("DOP");
    expect(order.order.paymentStatus).toBe("PENDIENTE");
    expect(order.tickets).toHaveLength(3);
    expect(order.tickets.map((t) => t.number)).toEqual([5, 6, 7]);
    expect(order.tickets.every((t) => t.status === "RESERVADO")).toBe(true);
    expect(order.paymentInstructions?.reference).toBe(order.order.code);
    expect(order.paymentInstructions?.amount).toBe(300);
    const reservation = await db.reservation.findFirst({ where: { raffleId: raffle.id } });
    expect(reservation?.status).toBe("CONFIRMADA");
    const acceptance = await db.termsAcceptance.findFirst({ where: { raffleId: raffle.id, buyerEmail: "cliente@test.do" } });
    expect(acceptance).not.toBeNull();
    expect(await db.payment.count({ where: { orderId: order.order.id } })).toBe(1);
  });

  it("compra invitada directa (sin reserva ni usuario) crea el pedido", async () => {
    const { raffle } = await makeRaffle({ ticketPrice: 250 });
    const order = await createOrder({
      raffleId: raffle.id,
      buyerName: "Invitado",
      buyerEmail: "invitado@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [42],
      idempotencyKey: "guest-1",
    });
    expect(order.order.status).toBe("PENDIENTE");
    expect(order.order.totalAmount).toBe(250);
    expect(order.order.buyerEmail).toBe("invitado@test.do");
    expect(await db.order.count()).toBe(1);
  });

  it("idempotencia de pedido: misma clave → mismo pedido, sin duplicar nada", async () => {
    const { order } = await buyWithReservation("cliente@test.do", [11, 12], "idem-1");
    const replay = await createOrder({
      raffleId: order.order.raffleId,
      buyerName: "Otro Nombre",
      buyerEmail: "otro@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [99],
      idempotencyKey: "idem-1",
    });
    expect(replay.created).toBe(false);
    expect(replay.order.id).toBe(order.order.id);
    expect(replay.order.code).toBe(order.order.code);
    expect(replay.tickets.map((t) => t.number)).toEqual([11, 12]);
    expect(await db.order.count()).toBe(1);
    expect(await db.payment.count()).toBe(1);
    expect(await db.ticket.count()).toBe(2);
  });

  it("P20: reintento tras caída (3x, misma clave, secuencial y concurrente) → un solo pedido/cobro/boletos", async () => {
    const { raffle } = await makeRaffle();
    const input = {
      raffleId: raffle.id,
      buyerName: "Cliente",
      buyerEmail: "p20@test.do",
      paymentMethodCode: "MANUAL_TRANSFER" as const,
      numbers: [20, 21],
      idempotencyKey: "p20-key",
    };
    const results = await Promise.allSettled([createOrder(input), createOrder(input), createOrder(input)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(3);
    const ids = new Set(fulfilled.map((r) => (r as PromiseFulfilledResult<{ order: { id: string } }>).value.order.id));
    expect(ids.size).toBe(1);
    expect(await db.order.count()).toBe(1);
    expect(await db.payment.count()).toBe(1);
    expect(await db.ticket.count({ where: { raffleId: raffle.id } })).toBe(2);
    // Un cuarto intento (reintento tardío) devuelve lo mismo.
    const late = await createOrder({ ...input, numbers: [30] });
    expect(late.created).toBe(false);
    expect(await db.ticket.count({ where: { raffleId: raffle.id } })).toBe(2);
  });

  it("P19: pago confirmado sin boletos → recuperación emite boletos sin duplicar", async () => {
    const { order } = await buyWithReservation("p19@test.do", [7, 8], "p19-1");
    // Simula la caída a mitad de camino: pago confirmado, boletos perdidos.
    await db.ticket.deleteMany({ where: { orderId: order.order.id } });
    await db.payment.updateMany({ where: { orderId: order.order.id }, data: { status: "APROBADO" } });
    const recovered = await recoverConfirmedPaymentWithoutTickets(order.order.id, [7, 8], { reason: "webhook llegó, boletos no se emitieron" });
    expect(recovered.recovered).toBe(true);
    expect(recovered.tickets.map((t) => t.number)).toEqual([7, 8]);
    expect(recovered.tickets.every((t) => t.status === "VENDIDO")).toBe(true);
    expect(recovered.order.status).toBe("CONFIRMADO");
    expect(await db.ticket.count({ where: { orderId: order.order.id } })).toBe(2);
    const cases = await db.reconciliationCase.findMany({ where: { status: "RESUELTO" } });
    expect(cases.length).toBeGreaterThanOrEqual(1);
    // Segunda recuperación: idempotente, no duplica.
    const again = await recoverConfirmedPaymentWithoutTickets(order.order.id, [7, 8], {});
    expect(again.recovered).toBe(false);
    expect(await db.ticket.count({ where: { orderId: order.order.id } })).toBe(2);
  });

  it("P19 sin pago confirmado → 409 (no hay nada que recuperar)", async () => {
    const { order } = await buyWithReservation("p19b@test.do", [7], "p19-2");
    await db.ticket.deleteMany({ where: { orderId: order.order.id } });
    await expect(
      recoverConfirmedPaymentWithoutTickets(order.order.id, [7], {}),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("método no operativo → 503; acceptTerms false → 400; reserva vencida → 409", async () => {
    const { raffle } = await makeRaffle();
    await expect(
      createOrder({
        raffleId: raffle.id,
        buyerName: "X",
        buyerEmail: "x@test.do",
        paymentMethodCode: "PAYPAL",
        numbers: [1],
        idempotencyKey: "m-1",
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      createOrder({
        raffleId: raffle.id,
        buyerName: "X",
        buyerEmail: "x@test.do",
        paymentMethodCode: "MANUAL_TRANSFER",
        numbers: [1],
        idempotencyKey: "m-2",
        acceptTerms: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const res = await createReservation({ raffleId: raffle.id, buyerEmail: "x@test.do", numbers: [2], idempotencyKey: "m-3r" });
    await db.reservation.update({ where: { id: res.reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(
      createOrder({
        raffleId: raffle.id,
        buyerName: "X",
        buyerEmail: "x@test.do",
        paymentMethodCode: "MANUAL_TRANSFER",
        reservationId: res.reservationId,
        idempotencyKey: "m-3",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("admin cancela un pedido PENDIENTE y libera los boletos; CONFIRMADO no se cancela", async () => {
    const { order } = await buyWithReservation("cancel@test.do", [15, 16], "cancel-1");
    const admin = await createUser({ role: "SUPERADMIN", email: "admin-cancel@test.do" });
    const cancelled = await cancelOrder(order.order.id, { actorId: admin.id, reason: "prueba" });
    expect(cancelled.status).toBe("EXPIRADO");
    const tickets = await db.ticket.findMany({ where: { raffleId: order.order.raffleId } });
    expect(tickets.every((t) => t.status === "DISPONIBLE")).toBe(true);
    expect(await db.payment.findFirst({ where: { orderId: order.order.id } })).toMatchObject({ status: "FALLIDO" });
    await expect(cancelOrder(order.order.id, { actorId: admin.id })).rejects.toMatchObject({ status: 409 });
  });
});

describe("S4 afiliados", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  async function buy(opts: { affiliateCode?: string; buyerEmail?: string; buyerPhone?: string; useLatestClick?: boolean; key?: string }) {
    const { raffle } = await makeRaffle();
    return createOrder({
      raffleId: raffle.id,
      buyerName: "Comprador",
      buyerEmail: opts.buyerEmail ?? "comprador@test.do",
      buyerPhone: opts.buyerPhone,
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [1],
      affiliateCode: opts.affiliateCode,
      useLatestClick: opts.useLatestClick,
      idempotencyKey: opts.key ?? `aff-${Math.random()}`,
    });
  }

  it("código de afiliado atribuye la venta con su código", async () => {
    const aff = await makeAffiliate("PRENDEAAA", "afiliado@test.do");
    const order = await buy({ affiliateCode: "PRENDEAAA", key: "aff-1" });
    expect(order.order.affiliateCode).toBe("PRENDEAAA");
    const saved = await db.order.findUnique({ where: { id: order.order.id } });
    expect(saved?.affiliateId).toBe(aff.id);
  });

  it("último clic gana: dos afiliados clican, compra sin código → el último", async () => {
    const a = await makeAffiliate("PRENDEAAA", "a@test.do");
    const b = await makeAffiliate("PRENDEBBB", "b@test.do");
    const { raffle } = await makeRaffle();
    await db.click.create({ data: { affiliateId: a.id, raffleId: raffle.id, code: "PRENDEAAA", clickedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await db.click.create({ data: { affiliateId: b.id, raffleId: raffle.id, code: "PRENDEBBB", clickedAt: new Date() } });
    const resolved = await resolveAffiliate({ raffleId: raffle.id, buyerEmail: "comprador@test.do" });
    expect(resolved.affiliateId).toBe(b.id);
    expect(resolved.affiliateCode).toBe("PRENDEBBB");
  });

  it("ventana 7 días: clic de hace 8 días no atribuye", async () => {
    const aff = await makeAffiliate("PRENDEAAA", "a@test.do");
    const { raffle } = await makeRaffle();
    await db.click.create({
      data: { affiliateId: aff.id, raffleId: raffle.id, code: "PRENDEAAA", clickedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });
    const resolved = await resolveAffiliate({ affiliateCode: "PRENDEAAA", raffleId: raffle.id, buyerEmail: "comprador@test.do" });
    expect(resolved.affiliateId).toBeNull();
    const order = await buy({ affiliateCode: "PRENDEAAA", key: "aff-old" });
    expect(order.order.affiliateCode).toBeNull();
  });

  it("clic de hace 6 días sí atribuye (dentro de la ventana)", async () => {
    const aff = await makeAffiliate("PRENDEAAA", "a@test.do");
    const { raffle } = await makeRaffle();
    const clickedAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    await db.click.create({ data: { affiliateId: aff.id, raffleId: raffle.id, code: "PRENDEAAA", clickedAt } });
    const resolved = await resolveAffiliate({ affiliateCode: "PRENDEAAA", raffleId: raffle.id, buyerEmail: "comprador@test.do" });
    expect(resolved.affiliateId).toBe(aff.id);
    expect(resolved.clickedAt?.getTime()).toBe(clickedAt.getTime());
  });

  it("auto-referido bloqueado: mismo email que el afiliado → sin comisión", async () => {
    await makeAffiliate("PRENDEAAA", "yo@test.do");
    const order = await buy({ affiliateCode: "PRENDEAAA", buyerEmail: "yo@test.do", key: "aff-self" });
    expect(order.selfReferralBlocked).toBe(true);
    expect(order.order.affiliateCode).toBeNull();
    const saved = await db.order.findUnique({ where: { id: order.order.id } });
    expect(saved?.affiliateId).toBeNull();
  });

  it("auto-referido por teléfono también se bloquea", async () => {
    await db.user.create({
      data: { name: "Afiliado", email: "af@test.do", passwordHash: "x", role: "AFILIADO", referralCode: "PRENDECCC", phone: "8095559999" },
    });
    const order = await buy({ affiliateCode: "PRENDECCC", buyerEmail: "otro@test.do", buyerPhone: "8095559999", key: "aff-self2" });
    expect(order.selfReferralBlocked).toBe(true);
    expect(order.order.affiliateCode).toBeNull();
  });
});

describe("S4 boletos", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("disponibilidad real: disponibles/reservados/vendidos", async () => {
    const { raffle } = await makeRaffle({ totalTickets: 10 });
    await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [1, 2], idempotencyKey: "av-1" });
    const order = await createOrder({
      raffleId: raffle.id,
      buyerName: "B",
      buyerEmail: "b@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [3],
      idempotencyKey: "av-2",
    });
    await db.ticket.updateMany({ where: { orderId: order.order.id }, data: { status: "VENDIDO" } });
    const avail = await getAvailability(raffle.id);
    expect(avail.availableCount).toBe(7);
    expect(avail.reserved).toEqual([1, 2]);
    expect(avail.sold).toEqual([3]);
    expect(avail.available).not.toContain(1);
  });

  it("bloqueo/desbloqueo: BLOCKED no se vende; unblock lo libera", async () => {
    const { raffle } = await makeRaffle({ totalTickets: 5 });
    const admin = await createUser({ role: "SUPERADMIN", email: "admin-block@test.do" });
    const ticket = await db.ticket.create({
      data: { raffleId: raffle.id, number: 4, code: "PR-TEST-0004", status: "DISPONIBLE" },
    });
    const blocked = await blockTicket(ticket.id, admin.id, "sospechoso");
    expect(blocked.status).toBe("BLOCKED");
    await expect(
      createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [4], idempotencyKey: "bl-1" }),
    ).rejects.toMatchObject({ status: 409 });
    const unblocked = await unblockTicket(ticket.id, admin.id);
    expect(unblocked.status).toBe("DISPONIBLE");
    const res = await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [4], idempotencyKey: "bl-2" });
    expect(res.numbers).toEqual([4]);
  });

  it("anulación con motivo: RESERVADO libera el número; VENDIDO marca reembolso", async () => {
    const { raffle } = await makeRaffle({ totalTickets: 10 });
    const admin = await createUser({ role: "SUPERADMIN", email: "admin-annul@test.do" });
    // Anulación de reservado (sin pedido).
    await createReservation({ raffleId: raffle.id, buyerEmail: "a@test.do", numbers: [5], idempotencyKey: "an-1" });
    const reserved = await db.ticket.findFirst({ where: { raffleId: raffle.id, number: 5 } });
    const annulled = await annulTicket(reserved!.id, admin.id, "número duplicado por error");
    expect(annulled.ticket.status).toBe("ANULADO");
    expect(annulled.refundRequired).toBe(false);
    const avail = await getAvailability(raffle.id);
    expect(avail.available).toContain(5);
    // Anulación de vendido (pagado): exige reembolso.
    const order = await createOrder({
      raffleId: raffle.id,
      buyerName: "B",
      buyerEmail: "b@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [6],
      idempotencyKey: "an-2",
    });
    await db.ticket.updateMany({ where: { orderId: order.order.id }, data: { status: "VENDIDO" } });
    await db.order.update({ where: { id: order.order.id }, data: { status: "CONFIRMADO" } });
    const sold = await db.ticket.findFirst({ where: { raffleId: raffle.id, number: 6 } });
    const annulledPaid = await annulTicket(sold!.id, admin.id, "comprador pidió devolución");
    expect(annulledPaid.refundRequired).toBe(true);
    expect(annulledPaid.refundAmount).toBe(100);
    expect(annulledPaid.orderCode).toBe(order.order.code);
    const audit = await db.auditLog.findFirst({ where: { action: "tickets.annul", entityId: sold!.id } });
    expect(audit).not.toBeNull();
  });

  it("verificación pública por código: sin datos privados, con si ganó", async () => {
    const { raffle } = await makeRaffle();
    const order = await createOrder({
      raffleId: raffle.id,
      buyerName: "Privado",
      buyerEmail: "privado@test.do",
      buyerPhone: "8095550000",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [77],
      idempotencyKey: "ver-1",
    });
    const ticket = order.tickets[0];
    const result = await verifyTicket(ticket.code);
    expect(result.number).toBe(77);
    expect(result.isWinner).toBe(false);
    expect(result.raffleTitle).toBe("Rifa S4");
    expect(result).not.toHaveProperty("buyerEmail");
    expect(result).not.toHaveProperty("buyerPhone");
    await expect(verifyTicket("PR-NOEXISTE-0000")).rejects.toMatchObject({ status: 404 });
  });
});

describe("S4 endpoints HTTP", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedManual();
  });

  it("reserve → 201 y replay con misma clave → 200; purchase → 201, replay → 200", async () => {
    const { raffle } = await makeRaffle();
    const res1 = await reserveRoute(
      req(`/api/raffles/${raffle.id}/reserve`, {
        method: "POST",
        body: { numbers: [8], buyerEmail: "web@test.do" },
        idempotencyKey: "http-res-1",
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(res1.status).toBe(201);
    const res1b = await reserveRoute(
      req(`/api/raffles/${raffle.id}/reserve`, {
        method: "POST",
        body: { numbers: [8], buyerEmail: "web@test.do" },
        idempotencyKey: "http-res-1",
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(res1b.status).toBe(200);
    const reservation = (await res1.json()) as { reservationId: string };
    const buy1 = await purchaseRoute(
      req(`/api/raffles/${raffle.id}/purchase`, {
        method: "POST",
        body: { reservationId: reservation.reservationId, paymentMethodCode: "MANUAL_TRANSFER", buyerName: "Web", buyerEmail: "web@test.do" },
        idempotencyKey: "http-buy-1",
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(buy1.status).toBe(201);
    const buy1Body = (await buy1.json()) as { order: { code: string }; paymentInstructions: { reference: string } };
    expect(buy1Body.paymentInstructions.reference).toBe(buy1Body.order.code);
    const buy2 = await purchaseRoute(
      req(`/api/raffles/${raffle.id}/purchase`, {
        method: "POST",
        body: { reservationId: reservation.reservationId, paymentMethodCode: "MANUAL_TRANSFER", buyerName: "Web", buyerEmail: "web@test.do" },
        idempotencyKey: "http-buy-1",
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(buy2.status).toBe(200);
    // Sin Idempotency-Key → 400.
    const noKey = await purchaseRoute(
      req(`/api/raffles/${raffle.id}/purchase`, {
        method: "POST",
        body: { numbers: [9], paymentMethodCode: "MANUAL_TRANSFER", buyerName: "Web", buyerEmail: "web@test.do" },
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(noKey.status).toBe(400);
    // GET pedido por código + comprobante con QR.
    const got = await orderRoute(req(`/api/orders/${buy1Body.order.code}`), { params: Promise.resolve({ code: buy1Body.order.code }) });
    expect(got.status).toBe(200);
    const receipt = await receiptRoute(req(`/api/orders/${buy1Body.order.code}/receipt?format=json`), { params: Promise.resolve({ code: buy1Body.order.code }) });
    expect(receipt.status).toBe(200);
    const receiptBody = (await receipt.json()) as { qrCode: string; qrPayload: string };
    expect(receiptBody.qrCode.startsWith("data:image/png;base64,")).toBe(true);
    expect(receiptBody.qrPayload).toContain(buy1Body.order.code);
    // Verificación pública por código de boleto.
    const order = await db.order.findUnique({ where: { code: buy1Body.order.code }, include: { tickets: true } });
    const verify = await verifyRoute(req(`/api/tickets/verify?code=${order!.tickets[0].code}`));
    expect(verify.status).toBe(200);
  });

  it("orders/mine: sin sesión → 401; con sesión lista las compras del usuario (incl. invitada con su email)", async () => {
    const user = await createUser({ role: "CLIENTE", email: "mio@test.do" });
    const { raffle } = await makeRaffle();
    await createOrder({
      raffleId: raffle.id,
      buyerName: "Mío",
      buyerEmail: "mio@test.do",
      userId: user.id,
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [55],
      idempotencyKey: "mine-1",
    });
    const noAuth = await mineRoute(req("/api/orders/mine"));
    expect(noAuth.status).toBe(401);
    const token = await loginToken(user);
    const mine = await mineRoute(req("/api/orders/mine", { token }));
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { data: Array<{ buyerEmail: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0].buyerEmail).toBe("mio@test.do");
  });

  it("admin: sin sesión → 401; con SUPERADMIN lista pedidos y cancela liberando boletos", async () => {
    const { raffle } = await makeRaffle();
    const order = await createOrder({
      raffleId: raffle.id,
      buyerName: "C",
      buyerEmail: "c@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      numbers: [31, 32],
      idempotencyKey: "adm-1",
    });
    const noAuth = await adminOrdersRoute(req("/api/admin/orders"));
    expect(noAuth.status).toBe(401);
    const admin = await createUser({ role: "SUPERADMIN", email: "admin@test.do" });
    const token = await loginToken(admin);
    const list = await adminOrdersRoute(req("/api/admin/orders?status=PENDIENTE", { token }));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<{ code: string }>; total: number };
    expect(listBody.total).toBe(1);
    const cancelled = await adminCancelRoute(
      req(`/api/admin/orders/${order.order.id}/cancel`, { method: "POST", body: { reason: "fraude" }, token }),
      { params: Promise.resolve({ id: order.order.id }) },
    );
    expect(cancelled.status).toBe(200);
    const tickets = await db.ticket.findMany({ where: { raffleId: raffle.id } });
    expect(tickets.every((t) => t.status === "DISPONIBLE")).toBe(true);
    const adminTickets = await adminTicketsRoute(req(`/api/admin/tickets?raffleId=${raffle.id}`, { token }));
    expect(adminTickets.status).toBe(200);
    // Auditor (solo lectura) no puede cancelar.
    const auditor = await createUser({ role: "AUDITOR", email: "auditor@test.do" });
    const auditorToken = await loginToken(auditor);
    const denied = await adminCancelRoute(
      req(`/api/admin/orders/${order.order.id}/cancel`, { method: "POST", body: {}, token: auditorToken }),
      { params: Promise.resolve({ id: order.order.id }) },
    );
    expect(denied.status).toBe(403);
  });
});
