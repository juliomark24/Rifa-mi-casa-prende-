// Huecos del contrato (coordinador, 21 nov 2026): tickets públicos,
// clic de afiliado, integraciones, detalle de rifa, commitment,
// countries/[id], terms, PATCH estandarizados, credenciales del panel,
// enum BLOCKED.
import { beforeEach, describe, expect, it } from "vitest";
import { POST as click } from "../src/app/api/affiliates/click/route";
import { GET as countriesDetail } from "../src/app/api/admin/countries/[id]/route";
import { PATCH as fraudPatch } from "../src/app/api/admin/fraud-cases/[id]/route";
import { GET as integrations } from "../src/app/api/admin/integrations/route";
import { POST as integrationsTest } from "../src/app/api/admin/integrations/[provider]/test-sandbox/route";
import { PATCH as providerPatch } from "../src/app/api/admin/payment-providers/[id]/route";
import { PATCH as supportPatch } from "../src/app/api/admin/support-tickets/[id]/route";
import { GET as termsList, POST as termsCreate } from "../src/app/api/admin/terms/route";
import { PATCH as winnerPatch } from "../src/app/api/admin/winners/[id]/route";
import { GET as commitment } from "../src/app/api/draws/[raffleId]/commitment/route";
import { GET as raffleDetail } from "../src/app/api/raffles/[id]/route";
import { GET as mine } from "../src/app/api/support-tickets/mine/route";
import { POST as createTicket } from "../src/app/api/support-tickets/route";
import { db } from "../src/lib/db";
import { computeDraw } from "../src/lib/draw";
import { cleanDb, createUser, loginToken, makeRequest, seedProviders } from "./helpers";

async function seedCountryRaffle() {
  const country = await db.country.create({
    data: {
      code: "DO",
      name: "República Dominicana",
      currencyCode: "DOP",
      currencySymbol: "RD$",
      timezone: "America/Santo_Domingo",
      classification: "A",
      status: "ACTIVO",
      availableLanguages: ["es"],
    },
  });
  const raffle = await db.raffle.create({
    data: {
      title: "Rifa test",
      description: "d",
      prize: "premio",
      countryId: country.id,
      currency: "DOP",
      ticketPrice: 100,
      totalTickets: 10,
      drawAt: new Date(Date.now() + 86400000),
      status: "ACTIVA",
    },
  });
  return { country, raffle };
}

describe("hueco 1: tickets de soporte públicos", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("POST público crea ticket TKT-000001 con prioridad ALTA si es pago sin boleto", async () => {
    const res = await createTicket(
      makeRequest("/api/support-tickets", {
        method: "POST",
        body: { type: "PAGO_SIN_BOLETO", buyerEmail: "c@test.do", message: "Pagué y no recibí mi boleto" },
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ticket: { number: string; status: string } };
    expect(json.ticket.number).toBe("TKT-000001");
    expect(json.ticket.status).toBe("ABIERTO");
    const row = await db.supportTicket.findFirstOrThrow();
    expect(row.priority).toBe("ALTA");
    expect(row.buyerEmail).toBe("c@test.do");
  });

  it("POST con orderCode inexistente → 400; mensaje corto → 400", async () => {
    const badOrder = await createTicket(
      makeRequest("/api/support-tickets", {
        method: "POST",
        body: { type: "OTRO", buyerEmail: "c@test.do", orderCode: "ORD-NOEXISTE", message: "Mensaje suficientemente largo" },
      }),
    );
    expect(badOrder.status).toBe(400);
    const short = await createTicket(
      makeRequest("/api/support-tickets", {
        method: "POST",
        body: { type: "OTRO", buyerEmail: "c@test.do", message: "corto" },
      }),
    );
    expect(short.status).toBe(400);
  });

  it("GET /mine lista los tickets del usuario autenticado", async () => {
    const user = await createUser({ email: "cliente@test.do" });
    await createTicket(
      makeRequest("/api/support-tickets", {
        method: "POST",
        body: { type: "OTRO", buyerEmail: "cliente@test.do", message: "Mensaje suficientemente largo" },
      }),
    );
    const res = await mine(makeRequest("/api/support-tickets/mine", { token: await loginToken(user) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[]; total: number };
    expect(json.total).toBe(1);
    expect(json.data).toHaveLength(1);
    expect((await mine(makeRequest("/api/support-tickets/mine"))).status).toBe(401);
  });
});

describe("hueco 2: clic de afiliado", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("registra el clic con clickedAt; 404 con código desconocido", async () => {
    const affiliate = await createUser({ role: "AFILIADO", email: "af@test.do" });
    await db.user.update({ where: { id: affiliate.id }, data: { referralCode: "PRENDETEST" } });
    const { raffle } = await seedCountryRaffle();
    const res = await click(
      makeRequest("/api/affiliates/click", {
        method: "POST",
        body: { code: "PRENDETEST", raffleId: raffle.id },
      }),
    );
    expect(res.status).toBe(200);
    const row = await db.click.findFirstOrThrow();
    expect(row.affiliateId).toBe(affiliate.id);
    expect(row.clickedAt).toBeInstanceOf(Date);
    const unknown = await click(
      makeRequest("/api/affiliates/click", { method: "POST", body: { code: "NOEXISTE" } }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("hueco 3: integraciones", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedProviders();
  });

  it("GET /integrations: 4 proveedores con gate; sin valores de credenciales", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const res = await integrations(makeRequest("/api/admin/integrations", { token: await loginToken(admin) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ provider: string; status: string; gate: { ok: boolean; reasons: string[] } }>;
    };
    expect(json.data).toHaveLength(4);
    const manual = json.data.find((p) => p.provider === "MANUAL_TRANSFER")!;
    expect(manual.status).toBe("OPERATIVO");
    expect(manual.gate.ok).toBe(true);
    const azul = json.data.find((p) => p.provider === "AZUL")!;
    expect(azul.status).toBe("NO_OPERATIVO");
    expect(azul.gate.ok).toBe(false);
    expect(JSON.stringify(json)).not.toContain("credentialsEncrypted");
  });

  it("POST /integrations/[provider]/test-sandbox: manual 200, Azul 503", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const ok = await integrationsTest(
      makeRequest("/api/admin/integrations/MANUAL_TRANSFER/test-sandbox", { method: "POST", token }),
      { params: Promise.resolve({ provider: "MANUAL_TRANSFER" }) },
    );
    expect(ok.status).toBe(200);
    const fail = await integrationsTest(
      makeRequest("/api/admin/integrations/AZUL/test-sandbox", { method: "POST", token }),
      { params: Promise.resolve({ provider: "AZUL" }) },
    );
    expect(fail.status).toBe(503);
    const missing = await integrationsTest(
      makeRequest("/api/admin/integrations/NOPE/test-sandbox", { method: "POST", token }),
      { params: Promise.resolve({ provider: "NOPE" }) },
    );
    expect(missing.status).toBe(404);
  });

  it("PATCH con {credentials} las cifra, no las devuelve, y las fusiona", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const paypal = await db.paymentProvider.findUniqueOrThrow({ where: { code: "PAYPAL" } });
    const res = await providerPatch(
      makeRequest(`/api/admin/payment-providers/${paypal.id}`, {
        method: "PATCH",
        body: { credentials: { clientId: "abc-123", clientSecret: "shh-secreto", empty: "" } },
        token,
      }),
      { params: Promise.resolve({ id: paypal.id }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(JSON.stringify(json)).not.toContain("abc-123");
    expect(JSON.stringify(json)).not.toContain("shh-secreto");
    expect(json.data.credentialsConfigured).toBe(true);
    expect(json.data.credentialKeys).toEqual(["clientId", "clientSecret"]);
    // El campo vacío no se guardó.
    const row = await db.paymentProvider.findUniqueOrThrow({ where: { id: paypal.id } });
    expect(row.credentialsEncrypted).toBeTruthy();
    expect(row.credentialsRef).toBe("panel:clientId,clientSecret");
    // Segundo PATCH fusiona: añade webhookId sin borrar clientId.
    const res2 = await providerPatch(
      makeRequest(`/api/admin/payment-providers/${paypal.id}`, {
        method: "PATCH",
        body: { credentials: { webhookId: "wh-1" } },
        token,
      }),
      { params: Promise.resolve({ id: paypal.id }) },
    );
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { data: { credentialKeys: string[] } }).data.credentialKeys).toEqual([
      "clientId",
      "clientSecret",
      "webhookId",
    ]);
    // Secreto suelto en el body → 400.
    const bad = await providerPatch(
      makeRequest(`/api/admin/payment-providers/${paypal.id}`, {
        method: "PATCH",
        body: { apiKey: "secreto-suelto" },
        token,
      }),
      { params: Promise.resolve({ id: paypal.id }) },
    );
    expect(bad.status).toBe(400);
  });
});

describe("hueco 4 y 7: detalle de rifa y commitment", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("GET /raffles/[id] devuelve soldNumbers y reservedNumbers", async () => {
    const { raffle } = await seedCountryRaffle();
    const mk = async (number: number, status: "VENDIDO" | "RESERVADO" | "DISPONIBLE") =>
      db.ticket.create({
        data: { raffleId: raffle.id, number, code: `PR-T-${number}`, status },
      });
    await mk(1, "VENDIDO");
    await mk(2, "VENDIDO");
    await mk(3, "RESERVADO");
    await mk(4, "DISPONIBLE");
    const res = await raffleDetail(makeRequest(`/api/raffles/${raffle.id}`), {
      params: Promise.resolve({ id: raffle.id }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      soldNumbers: number[];
      reservedNumbers: number[];
      soldCount: number;
      availableCount: number;
    };
    expect(json.soldNumbers).toEqual([1, 2]);
    expect(json.reservedNumbers).toEqual([3]);
    expect(json.soldCount).toBe(2);
    expect(json.availableCount).toBe(7);
    expect((await raffleDetail(makeRequest("/api/raffles/nope"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
  });

  it("GET /draws/[raffleId]/commitment: 404 sin sorteo; con sorteo no revela la seed", async () => {
    const { raffle } = await seedCountryRaffle();
    const missing = await commitment(makeRequest(`/api/draws/${raffle.id}/commitment`), {
      params: Promise.resolve({ raffleId: raffle.id }),
    });
    expect(missing.status).toBe(404);
    const draw = computeDraw([1, 2, 3, 4, 5]);
    await db.draw.create({
      data: {
        raffleId: raffle.id,
        commitment: draw.commitment,
        seed: null, // aún no revelada
        hashElegibles: draw.hashElegibles,
        eligibleSnapshot: draw.eligibleSnapshot,
        totalElegibles: draw.totalElegibles,
        algorithm: draw.algorithm,
      },
    });
    const res = await commitment(makeRequest(`/api/draws/${raffle.id}/commitment`), {
      params: Promise.resolve({ raffleId: raffle.id }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.commitment).toBe(draw.commitment);
    expect(json.seedRevealed).toBe(false);
    expect(json).not.toHaveProperty("seed");
  });

  it("GET /admin/countries/[id]: 200 con configs; 404 si no existe", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const { country } = await seedCountryRaffle();
    const res = await countriesDetail(makeRequest(`/api/admin/countries/${country.id}`, { token }), {
      params: Promise.resolve({ id: country.id }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { code: string } }).data.code).toBe("DO");
    const missing = await countriesDetail(makeRequest("/api/admin/countries/nope", { token }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
  });

  it("enum TicketStatus BLOCKED usable (block/unblock)", async () => {
    const { raffle } = await seedCountryRaffle();
    const ticket = await db.ticket.create({
      data: { raffleId: raffle.id, number: 1, code: "PR-B-1", status: "BLOCKED" },
    });
    expect(ticket.status).toBe("BLOCKED");
  });
});

describe("hueco 6 y 7: PATCH estandarizados y terms", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("terms: POST crea v1 y v2 (n+1) y marca vigente; GET ?raffleId= filtra", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const { raffle } = await seedCountryRaffle();
    const v1 = await termsCreate(
      makeRequest("/api/admin/terms", { method: "POST", body: { raffleId: raffle.id, content: "Bases versión 1 del sorteo." }, token }),
    );
    expect(v1.status).toBe(201);
    expect(((await v1.json()) as { data: { version: number } }).data.version).toBe(1);
    const v2 = await termsCreate(
      makeRequest("/api/admin/terms", { method: "POST", body: { raffleId: raffle.id, content: "Bases versión 2 del sorteo." }, token }),
    );
    expect(((await v2.json()) as { data: { version: number } }).data.version).toBe(2);
    const raffleAfter = await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } });
    const terms2 = await db.raffleTerms.findFirstOrThrow({ where: { raffleId: raffle.id, version: 2 } });
    expect(raffleAfter.termsVersionId).toBe(terms2.id);
    const list = await termsList(makeRequest(`/api/admin/terms?raffleId=${raffle.id}`, { token }));
    expect(((await list.json()) as { total: number }).total).toBe(2);
  });

  it("PATCH winner: avanza estado, fusiona evidencia, añade nota; cliente 403", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const { raffle } = await seedCountryRaffle();
    const wc = await db.winnerCase.create({ data: { raffleId: raffle.id, status: "PENDIENTE_CONTACTO" } });
    const res = await winnerPatch(
      makeRequest(`/api/admin/winners/${wc.id}`, {
        method: "PATCH",
        body: { status: "CONTACTADO", evidence: { llamada: "2026-11-21" }, note: "Contactado por WhatsApp" },
        token: await loginToken(admin),
      }),
      { params: Promise.resolve({ id: wc.id }) },
    );
    expect(res.status).toBe(200);
    const row = await db.winnerCase.findUniqueOrThrow({ where: { id: wc.id } });
    expect(row.status).toBe("CONTACTADO");
    expect(row.notes).toContain("WhatsApp");
    const cliente = await createUser({ role: "CLIENTE" });
    const denied = await winnerPatch(
      makeRequest(`/api/admin/winners/${wc.id}`, {
        method: "PATCH",
        body: { status: "ENTREGADO" },
        token: await loginToken(cliente),
      }),
      { params: Promise.resolve({ id: wc.id }) },
    );
    expect(denied.status).toBe(403);
    const bad = await winnerPatch(
      makeRequest(`/api/admin/winners/${wc.id}`, {
        method: "PATCH",
        body: { status: "INVENTADO" },
        token: await loginToken(admin),
      }),
      { params: Promise.resolve({ id: wc.id }) },
    );
    expect(bad.status).toBe(400);
  });

  it("PATCH support-ticket: asigna responsable y resuelve con resolvedAt", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const agent = await createUser({ role: "ADMIN_RIFAS", email: "agent@test.do" });
    const ticket = await db.supportTicket.create({
      data: { number: "TKT-000001", type: "OTRO", status: "ABIERTO", subject: "s", description: "d", buyerEmail: "c@test.do" },
    });
    // Máquina de estados del plan §2.17: ABIERTO → EN_REVISION → RESUELTO
    // (ABIERTO → RESUELTO directo no está permitido).
    const res1 = await supportPatch(
      makeRequest(`/api/admin/support-tickets/${ticket.id}`, {
        method: "PATCH",
        body: { status: "EN_REVISION", note: "En revisión" },
        token: await loginToken(admin),
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(res1.status).toBe(200);
    const res = await supportPatch(
      makeRequest(`/api/admin/support-tickets/${ticket.id}`, {
        method: "PATCH",
        body: { status: "RESUELTO", assignee: agent.id, note: "Resuelto: boleto reemitido" },
        token: await loginToken(admin),
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(res.status).toBe(200);
    const row = await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.status).toBe("RESUELTO");
    expect(row.ownerId).toBe(agent.id);
    expect(row.resolvedAt).not.toBeNull();
  });

  it("PATCH fraud-case: revisión humana con decisión y cierre", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const fc = await db.fraudCase.create({
      data: { rule: "velocity", reason: "muchos boletos", status: "REVISION", entityType: "Order", entityId: "ORD-1" },
    });
    const res = await fraudPatch(
      makeRequest(`/api/admin/fraud-cases/${fc.id}`, {
        method: "PATCH",
        body: { riskStatus: "BLOQUEADO", decision: "Compra con tarjeta robada: bloquear cuenta", note: "Revisado con el banco" },
        token: await loginToken(admin),
      }),
      { params: Promise.resolve({ id: fc.id }) },
    );
    expect(res.status).toBe(200);
    const row = await db.fraudCase.findUniqueOrThrow({ where: { id: fc.id } });
    expect(row.status).toBe("BLOQUEADO");
    expect(row.decision).toContain("tarjeta robada");
    expect(row.reviewedById).toBe(admin.id);
    expect(row.resolvedAt).not.toBeNull();
  });
});
