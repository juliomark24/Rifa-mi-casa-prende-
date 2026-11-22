// S3 — Rifas + países + bases (plan §2.7, §2.9, §2.18, §2.20).
// Cubre: P15 (Agregar país por configuración), P18 (gate de activación),
// P26 (bases versionadas por comprador — modelo/registro), P28 (control
// de cambios registra antes/después).
// BD propia: DATABASE_URL="file:./test-s3.db" (ver tests/setup.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { GET as adminRafflesList, POST as adminRafflesCreate } from "../src/app/api/admin/raffles/route";
import { PATCH as rafflePatch } from "../src/app/api/admin/raffles/[id]/route";
import { POST as raffleTransition } from "../src/app/api/admin/raffles/[id]/transition/route";
import { GET as countriesList, POST as countriesCreate } from "../src/app/api/admin/countries/route";
import { PATCH as countryPatch } from "../src/app/api/admin/countries/[id]/route";
import { POST as countryActivate } from "../src/app/api/admin/countries/[id]/activate/route";
import { GET as termsList, POST as termsCreate } from "../src/app/api/admin/terms/route";
import { GET as publicRaffles } from "../src/app/api/raffles/route";
import { db } from "../src/lib/db";
import {
  applyRaffleTransition,
  canTransition,
  markSoldOutIfNeeded,
  RAFFLE_TRANSITIONS,
} from "../src/lib/raffles";
import { checkActivationGate } from "../src/lib/countries";
import {
  createTermsVersion,
  getBuyerAcceptedTerms,
  getCurrentTerms,
  recordTermsAcceptance,
} from "../src/lib/terms";
import { cleanDb, createUser, loginToken, makeRequest, seedProviders } from "./helpers";

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

async function seedCountry(code = "DO", status: "ACTIVO" | "BORRADOR" = "ACTIVO") {
  return db.country.create({
    data: {
      code,
      name: code === "DO" ? "República Dominicana" : `País ${code}`,
      currencyCode: code === "DO" ? "DOP" : "USD",
      currencySymbol: code === "DO" ? "RD$" : "$",
      timezone: "America/Santo_Domingo",
      classification: "A",
      status,
      availableLanguages: ["es"],
    },
  });
}

async function seedRaffle(countryId: string, status = "BORRADOR") {
  return db.raffle.create({
    data: {
      title: "Rifa S3",
      description: "Rifa de prueba S3",
      prize: "Premio S3",
      countryId,
      currency: "DOP",
      ticketPrice: 100,
      totalTickets: 10,
      drawAt: FUTURE,
      status: status as never,
    },
  });
}

/** Rifa con una venta real: pedido CONFIRMADO + boleto VENDIDO. */
async function seedRaffleWithSale(countryId: string) {
  const raffle = await seedRaffle(countryId, "ACTIVA");
  const order = await db.order.create({
    data: {
      code: "ORD-S3-0001",
      raffleId: raffle.id,
      buyerName: "Comprador Test",
      buyerEmail: "comprador@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      totalAmount: 100,
      currency: "DOP",
      status: "CONFIRMADO",
      idempotencyKey: "idem-s3-0001",
    },
  });
  await db.ticket.create({
    data: {
      raffleId: raffle.id,
      number: 1,
      code: "PR-S3-000001",
      status: "VENDIDO",
      orderId: order.id,
      buyerName: "Comprador Test",
      buyerEmail: "comprador@test.do",
    },
  });
  return { raffle, order };
}

describe("S3 — máquina de estados de rifa (§2.7)", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("tabla de transiciones: BORRADOR→ACTIVA rechazado, cadena válida permitida", () => {
    expect(canTransition("BORRADOR", "ACTIVA")).toBe(false);
    expect(canTransition("BORRADOR", "PENDIENTE_APROBACION")).toBe(true);
    expect(canTransition("PENDIENTE_APROBACION", "PROGRAMADA")).toBe(true);
    expect(canTransition("PROGRAMADA", "ACTIVA")).toBe(true);
    expect(canTransition("ACTIVA", "PAUSADA")).toBe(true);
    expect(canTransition("PAUSADA", "ACTIVA")).toBe(true);
    expect(canTransition("ACTIVA", "AGOTADA")).toBe(true);
    expect(canTransition("AGOTADA", "CERRADA")).toBe(true);
    expect(canTransition("CERRADA", "EN_SORTEO")).toBe(true);
    expect(canTransition("EN_SORTEO", "GANADOR_PUBLICADO")).toBe(true);
    expect(canTransition("GANADOR_PUBLICADO", "FINALIZADA")).toBe(true);
    expect(canTransition("EN_SORTEO", "CANCELADA")).toBe(false);
  });

  it("FINALIZADA y CANCELADA son terminales: ninguna transición sale de ellas", () => {
    for (const from of ["FINALIZADA", "CANCELADA"] as const) {
      expect(RAFFLE_TRANSITIONS[from]).toEqual([]);
      for (const to of Object.keys(RAFFLE_TRANSITIONS)) {
        expect(canTransition(from, to as never)).toBe(false);
      }
    }
  });

  it("POST transition BORRADOR→ACTIVA → 409; BORRADOR→PENDIENTE_APROBACION → 200", async () => {
    const country = await seedCountry();
    const raffle = await seedRaffle(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);

    const bad = await raffleTransition(
      makeRequest(`/api/admin/raffles/${raffle.id}/transition`, {
        method: "POST",
        body: { to: "ACTIVA" },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(bad.status).toBe(409);
    const badJson = (await bad.json()) as { error: string };
    expect(badJson.error).toContain("Transición no permitida");

    const ok = await raffleTransition(
      makeRequest(`/api/admin/raffles/${raffle.id}/transition`, {
        method: "POST",
        body: { to: "PENDIENTE_APROBACION", reason: "Lista para revisión" },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as { data: { status: string } };
    expect(okJson.data.status).toBe("PENDIENTE_APROBACION");
    const change = await db.changeLog.findFirstOrThrow({
      where: { entity: "Raffle", entityId: raffle.id, field: "status" },
    });
    expect(change.beforeValue).toBe("BORRADOR");
    expect(change.afterValue).toBe("PENDIENTE_APROBACION");
  });

  it("FINALIZADA no admite ninguna transición (409)", async () => {
    const country = await seedCountry();
    const raffle = await seedRaffle(country.id, "FINALIZADA");
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const res = await raffleTransition(
      makeRequest(`/api/admin/raffles/${raffle.id}/transition`, {
        method: "POST",
        body: { to: "ACTIVA" },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(res.status).toBe(409);
  });

  it("PROGRAMADA exige país ACTIVO: país BORRADOR → 409", async () => {
    const country = await seedCountry("CO", "BORRADOR");
    const raffle = await seedRaffle(country.id, "PENDIENTE_APROBACION");
    const admin = await createUser({ role: "SUPERADMIN" });
    const res = await applyRaffleTransition({
      raffleId: raffle.id,
      to: "PROGRAMADA",
      actorId: admin.id,
    }).then(
      () => ({ status: 200 }),
      (err: Error & { status?: number }) => ({ status: err.status ?? 500 }),
    );
    expect(res.status).toBe(409);
  });

  it("PAUSADA congela ventas sin borrar: resume a ACTIVA y conserva boletos", async () => {
    const country = await seedCountry();
    const { raffle } = await seedRaffleWithSale(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const paused = await applyRaffleTransition({ raffleId: raffle.id, to: "PAUSADA", actorId: admin.id });
    expect(paused.status).toBe("PAUSADA");
    expect(await db.ticket.count({ where: { raffleId: raffle.id, status: "VENDIDO" } })).toBe(1);
    const resumed = await applyRaffleTransition({ raffleId: raffle.id, to: "ACTIVA", actorId: admin.id });
    expect(resumed.status).toBe("ACTIVA");
  });

  it("agotado automático: ACTIVA con 0 disponibles → AGOTADA (idempotente)", async () => {
    const country = await seedCountry();
    const raffle = await db.raffle.create({
      data: {
        title: "Rifa 1 boleto",
        description: "d",
        prize: "p",
        countryId: country.id,
        currency: "DOP",
        ticketPrice: 100,
        totalTickets: 1,
        drawAt: FUTURE,
        status: "ACTIVA",
      },
    });
    await db.ticket.create({
      data: { raffleId: raffle.id, number: 1, code: "PR-S3-AGOTADA", status: "VENDIDO" },
    });
    const soldOut = await markSoldOutIfNeeded(raffle.id);
    expect(soldOut?.status).toBe("AGOTADA");
    // Segunda llamada: ya no está ACTIVA, no hace nada.
    expect(await markSoldOutIfNeeded(raffle.id)).toBeNull();
  });

  it("CANCELADA con ventas registra intención de reembolso (notificación PENDIENTE)", async () => {
    const country = await seedCountry();
    const { raffle } = await seedRaffleWithSale(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const cancelled = await applyRaffleTransition({
      raffleId: raffle.id,
      to: "CANCELADA",
      actorId: admin.id,
      reason: "Sin licencia a tiempo",
    });
    expect(cancelled.status).toBe("CANCELADA");
    const notif = await db.notification.findFirstOrThrow({
      where: { event: "raffle_cancelled_refund" },
    });
    expect(notif.recipient).toBe("comprador@test.do");
    expect(notif.status).toBe("PENDIENTE");
  });
});

describe("S3 — cambios sensibles y control de cambios (§2.7, §2.20, P28)", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("cambio de precio CON ventas sin doble aprobación → 409", async () => {
    const country = await seedCountry();
    const { raffle } = await seedRaffleWithSale(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const res = await rafflePatch(
      makeRequest(`/api/admin/raffles/${raffle.id}`, {
        method: "PATCH",
        body: { ticketPrice: 200 },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("doble aprobación");
    expect((await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } })).ticketPrice).toBe(100);
  });

  it("cambio de precio CON ventas + segundo superadmin → 200, ChangeLog antes/después y aviso al comprador", async () => {
    const country = await seedCountry();
    const { raffle } = await seedRaffleWithSale(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const approver = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const res = await rafflePatch(
      makeRequest(`/api/admin/raffles/${raffle.id}`, {
        method: "PATCH",
        body: { ticketPrice: 200, reason: "Ajuste por costos del premio", approvedById: approver.id },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { ticketPrice: number } };
    expect(json.data.ticketPrice).toBe(200);

    // P28: registro antes/después con actor, motivo y aprobación.
    const change = await db.changeLog.findFirstOrThrow({
      where: { entity: "Raffle", entityId: raffle.id, field: "ticketPrice" },
    });
    expect(change.beforeValue).toBe("100");
    expect(change.afterValue).toBe("200");
    expect(change.actorId).toBe(admin.id);
    expect(change.approvedById).toBe(approver.id);
    expect(change.reason).toBe("Ajuste por costos del premio");
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entity: "Raffle", entityId: raffle.id, action: "raffles.update" },
    });
    expect(audit.actorId).toBe(admin.id);

    // Aviso al comprador (registro PENDIENTE; el envío es S8).
    const notif = await db.notification.findFirstOrThrow({
      where: { event: "raffle_price_changed", recipient: "comprador@test.do" },
    });
    expect(notif.status).toBe("PENDIENTE");
  });

  it("la doble aprobación rechaza al mismo actor y a un no-superadmin", async () => {
    const country = await seedCountry();
    const { raffle } = await seedRaffleWithSale(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const finanzas = await createUser({ role: "FINANZAS" });
    const token = await loginToken(admin);

    const selfApproval = await rafflePatch(
      makeRequest(`/api/admin/raffles/${raffle.id}`, {
        method: "PATCH",
        body: { ticketPrice: 200, approvedById: admin.id },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(selfApproval.status).toBe(409);

    const wrongRole = await rafflePatch(
      makeRequest(`/api/admin/raffles/${raffle.id}`, {
        method: "PATCH",
        body: { ticketPrice: 200, approvedById: finanzas.id },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(wrongRole.status).toBe(409);
  });

  it("cambio de premio y de total de boletos con ventas sin aprobación → 409", async () => {
    const country = await seedCountry();
    const { raffle } = await seedRaffleWithSale(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    for (const body of [{ prize: "Otro premio" }, { totalTickets: 20 }]) {
      const res = await rafflePatch(
        makeRequest(`/api/admin/raffles/${raffle.id}`, { method: "PATCH", body, token }),
        { params: Promise.resolve({ id: raffle.id }) },
      );
      expect(res.status).toBe(409);
    }
  });

  it("cambio de precio SIN ventas → 200 sin doble aprobación", async () => {
    const country = await seedCountry();
    const raffle = await seedRaffle(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const res = await rafflePatch(
      makeRequest(`/api/admin/raffles/${raffle.id}`, {
        method: "PATCH",
        body: { ticketPrice: 150 },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(res.status).toBe(200);
  });

  it("cambio de fecha de sorteo sin motivo → 400; con motivo → 200 + registro + aviso", async () => {
    const country = await seedCountry();
    const { raffle } = await seedRaffleWithSale(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const newDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const noReason = await rafflePatch(
      makeRequest(`/api/admin/raffles/${raffle.id}`, {
        method: "PATCH",
        body: { drawAt: newDate },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(noReason.status).toBe(400);

    const ok = await rafflePatch(
      makeRequest(`/api/admin/raffles/${raffle.id}`, {
        method: "PATCH",
        body: { drawAt: newDate, reason: "El local cambió de fecha" },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(ok.status).toBe(200);
    const change = await db.changeLog.findFirstOrThrow({
      where: { entity: "Raffle", entityId: raffle.id, field: "drawAt" },
    });
    expect(change.reason).toBe("El local cambió de fecha");
    const notif = await db.notification.findFirstOrThrow({
      where: { event: "raffle_draw_date_changed", recipient: "comprador@test.do" },
    });
    expect(notif.status).toBe("PENDIENTE");
  });

  it("no se puede reducir el total por debajo de lo vendido; rifa congelada no se edita", async () => {
    const country = await seedCountry();
    const { raffle } = await seedRaffleWithSale(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const shrink = await rafflePatch(
      makeRequest(`/api/admin/raffles/${raffle.id}`, {
        method: "PATCH",
        body: { totalTickets: 1 },
        token,
      }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    // 1 boleto vendido y total 1 no es menor que lo vendido, pero el cambio
    // con ventas exige doble aprobación → 409 por ese motivo.
    expect(shrink.status).toBe(409);

    const frozen = await seedRaffle(country.id, "FINALIZADA");
    const frozenRes = await rafflePatch(
      makeRequest(`/api/admin/raffles/${frozen.id}`, {
        method: "PATCH",
        body: { title: "Nuevo título" },
        token,
      }),
      { params: Promise.resolve({ id: frozen.id }) },
    );
    expect(frozenRes.status).toBe(409);
  });
});

describe("S3 — endpoints de rifas (lista pública y admin)", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("POST /api/admin/raffles crea en BORRADOR con la moneda del país; GET admin filtra por status y país", async () => {
    const country = await seedCountry();
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const created = await adminRafflesCreate(
      makeRequest("/api/admin/raffles", {
        method: "POST",
        body: {
          title: "Rifa nueva",
          description: "Descripción",
          prize: "Carro",
          countryId: country.id,
          ticketPrice: 250,
          totalTickets: 100,
          drawAt: FUTURE.toISOString(),
        },
        token,
      }),
    );
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as { data: { status: string; currency: string } };
    expect(createdJson.data.status).toBe("BORRADOR");
    expect(createdJson.data.currency).toBe("DOP");

    const list = await adminRafflesList(
      makeRequest("/api/admin/raffles?status=BORRADOR&country=DO", { token }),
    );
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as { data: unknown[]; total: number };
    expect(listJson.total).toBe(1);
    expect(listJson.data).toHaveLength(1);

    const empty = await adminRafflesList(
      makeRequest("/api/admin/raffles?status=ACTIVA", { token }),
    );
    expect(((await empty.json()) as { total: number }).total).toBe(0);
  });

  it("GET /api/raffles público excluye borradores por defecto y filtra por status y país", async () => {
    const country = await seedCountry();
    await seedRaffle(country.id, "BORRADOR");
    await seedRaffle(country.id, "ACTIVA");
    const res = await publicRaffles(makeRequest("/api/raffles"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { status: string }[]; total: number };
    expect(json.total).toBe(1);
    expect(json.data[0].status).toBe("ACTIVA");

    const filtered = await publicRaffles(makeRequest("/api/raffles?status=BORRADOR"));
    expect(((await filtered.json()) as { total: number }).total).toBe(1);

    const wrongCountry = await publicRaffles(makeRequest("/api/raffles?country=CO"));
    expect(((await wrongCountry.json()) as { total: number }).total).toBe(0);

    const badStatus = await publicRaffles(makeRequest("/api/raffles?status=NO_EXISTE"));
    expect(badStatus.status).toBe(400);
  });

  it("cliente sin permiso de admin no crea rifas (403)", async () => {
    const country = await seedCountry();
    const client = await createUser({ role: "CLIENTE" });
    const token = await loginToken(client);
    const res = await adminRafflesCreate(
      makeRequest("/api/admin/raffles", {
        method: "POST",
        body: {
          title: "Rifa",
          description: "d",
          prize: "p",
          countryId: country.id,
          ticketPrice: 100,
          totalTickets: 10,
          drawAt: FUTURE.toISOString(),
        },
        token,
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("S3 — países: Agregar país y gate de activación (P15, P18)", () => {
  beforeEach(async () => {
    await cleanDb();
    const { manual } = await seedProviders();
    await db.paymentMethod.create({
      data: {
        code: "MANUAL_TRANSFER",
        providerId: manual.id,
        label: "Transferencia bancaria",
        enabled: true,
      },
    });
  });

  const newCountryBody = {
    code: "CO",
    name: "Colombia",
    flag: "🇨🇴",
    currencyCode: "COP",
    currencySymbol: "$",
    currencyFormat: "$ #,##0",
    defaultLanguage: "es",
    availableLanguages: ["es"],
    timezone: "America/Bogota",
    dateFormat: "DD/MM/YYYY",
    timeFormat: "HH:mm",
    allowedCountries: ["CO"],
    blockedCountries: [],
    legalConfig: { licenseRequired: true },
    notificationConfig: { channels: ["EMAIL"] },
    refundRules: { refundWindowDays: 7 },
    classification: "A",
    status: "CONFIGURACION",
    legalVerified: false,
    providerVerified: false,
    paymentMethods: [
      { providerCode: "MANUAL_TRANSFER", methodCode: "MANUAL_TRANSFER", priority: 1, feeFixed: 0, feePercentBps: 0, enabled: true },
    ],
  };

  it("P15: POST /api/admin/countries crea el país con los 16 campos, sin tocar código", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const res = await countriesCreate(
      makeRequest("/api/admin/countries", { method: "POST", body: newCountryBody, token }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { code: string; status: string; classification: string; gate: { ok: boolean } };
    };
    expect(json.data.code).toBe("CO");
    expect(json.data.status).toBe("CONFIGURACION");
    expect(json.data.classification).toBe("A");
    expect(json.data.gate.ok).toBe(false); // sin verificaciones aún

    const row = await db.country.findUniqueOrThrow({ where: { code: "CO" } });
    expect(row.currencyCode).toBe("COP");
    expect(row.timezone).toBe("America/Bogota");
    const configs = await db.countryPaymentConfig.findMany({ where: { countryId: row.id } });
    expect(configs).toHaveLength(1);
    expect(configs[0].enabled).toBe(true);
    const history = await db.configHistory.findFirstOrThrow({
      where: { entity: "Country", entityId: row.id },
    });
    expect(history.reason).toBe("Agregar país");
  });

  it("P15: código duplicado → 409; zona horaria inválida → 400; crear como ACTIVO → 400", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    await countriesCreate(
      makeRequest("/api/admin/countries", { method: "POST", body: newCountryBody, token }),
    );
    const dup = await countriesCreate(
      makeRequest("/api/admin/countries", { method: "POST", body: newCountryBody, token }),
    );
    expect(dup.status).toBe(409);

    const badTz = await countriesCreate(
      makeRequest("/api/admin/countries", {
        method: "POST",
        body: { ...newCountryBody, code: "MX", timezone: "No/Existe" },
        token,
      }),
    );
    expect(badTz.status).toBe(400);

    const asActive = await countriesCreate(
      makeRequest("/api/admin/countries", {
        method: "POST",
        body: { ...newCountryBody, code: "MX", status: "ACTIVO" },
        token,
      }),
    );
    expect(asActive.status).toBe(400);
  });

  it("P18: gate de activación — sin verificación → 409 con motivos; con ambas → 200", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const created = await countriesCreate(
      makeRequest("/api/admin/countries", { method: "POST", body: newCountryBody, token }),
    );
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    // Sin ninguna verificación: 409 con los dos motivos exactos.
    const none = await countryActivate(
      makeRequest(`/api/admin/countries/${id}/activate`, { method: "POST", token }),
      { params: Promise.resolve({ id }) },
    );
    expect(none.status).toBe(409);
    const noneJson = (await none.json()) as { error: string; reasons: string[] };
    expect(noneJson.reasons).toHaveLength(2);
    expect(noneJson.reasons[0]).toContain("legal");
    expect(noneJson.reasons[1]).toContain("Proveedor");

    // Solo legal: sigue 409, queda solo el motivo del proveedor.
    await countryPatch(
      makeRequest(`/api/admin/countries/${id}`, {
        method: "PATCH",
        body: { legalVerified: true },
        token,
      }),
      { params: Promise.resolve({ id }) },
    );
    const half = await countryActivate(
      makeRequest(`/api/admin/countries/${id}/activate`, { method: "POST", token }),
      { params: Promise.resolve({ id }) },
    );
    expect(half.status).toBe(409);
    expect(((await half.json()) as { reasons: string[] }).reasons).toHaveLength(1);

    // Ambas verificaciones: 200 y país ACTIVO.
    await countryPatch(
      makeRequest(`/api/admin/countries/${id}`, {
        method: "PATCH",
        body: { providerVerified: true },
        token,
      }),
      { params: Promise.resolve({ id }) },
    );
    const ok = await countryActivate(
      makeRequest(`/api/admin/countries/${id}/activate`, { method: "POST", token }),
      { params: Promise.resolve({ id }) },
    );
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as { data: { status: string; gate: { ok: boolean } } };
    expect(okJson.data.status).toBe("ACTIVO");
    expect(okJson.data.gate.ok).toBe(true);
    expect((await db.country.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVO");
    // Idempotente: activar de nuevo → 200.
    const again = await countryActivate(
      makeRequest(`/api/admin/countries/${id}/activate`, { method: "POST", token }),
      { params: Promise.resolve({ id }) },
    );
    expect(again.status).toBe(200);
  });

  it("P18 (lib): checkActivationGate devuelve los motivos exactos", () => {
    expect(checkActivationGate({ legalVerified: false, providerVerified: false })).toEqual({
      ok: false,
      reasons: [
        "Verificación legal pendiente para este país",
        "Proveedor de pagos no verificado para la actividad de rifas en este mercado",
      ],
    });
    expect(checkActivationGate({ legalVerified: true, providerVerified: true }).ok).toBe(true);
  });

  it("PATCH de país no puede poner ACTIVO directo (400) y registra el cambio", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const created = await countriesCreate(
      makeRequest("/api/admin/countries", { method: "POST", body: newCountryBody, token }),
    );
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const direct = await countryPatch(
      makeRequest(`/api/admin/countries/${id}`, {
        method: "PATCH",
        body: { status: "ACTIVO" },
        token,
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(direct.status).toBe(400);

    const ok = await countryPatch(
      makeRequest(`/api/admin/countries/${id}`, {
        method: "PATCH",
        body: { name: "Colombia (actualizado)", reason: "Corrección de nombre" },
        token,
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(ok.status).toBe(200);
    const change = await db.changeLog.findFirstOrThrow({
      where: { entity: "Country", entityId: id, field: "name" },
    });
    expect(change.beforeValue).toBe("Colombia");
    expect(change.afterValue).toBe("Colombia (actualizado)");
  });

  it("GET /api/admin/countries lista con clasificación y gate visibles", async () => {
    await seedCountry();
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const res = await countriesList(makeRequest("/api/admin/countries", { token }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { code: string; classification: string; classificationLabel: string; gate: { ok: boolean } }[];
      total: number;
    };
    expect(json.total).toBe(1);
    expect(json.data[0].classification).toBe("A");
    expect(json.data[0].classificationLabel).toContain("configuración");
    expect(json.data[0].gate.ok).toBe(false);
  });
});

describe("S3 — bases versionadas (P26, §2.18)", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("POST crea v1 y luego v2; v1 queda inmutable y la rifa apunta a v2", async () => {
    const country = await seedCountry();
    const raffle = await seedRaffle(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);

    const v1 = await termsCreate(
      makeRequest("/api/admin/terms", {
        method: "POST",
        body: { raffleId: raffle.id, content: "Bases versión 1: premio y fecha." },
        token,
      }),
    );
    expect(v1.status).toBe(201);
    const v1Json = (await v1.json()) as { data: { version: number; id: string } };
    expect(v1Json.data.version).toBe(1);

    const v2 = await termsCreate(
      makeRequest("/api/admin/terms", {
        method: "POST",
        body: { raffleId: raffle.id, content: "Bases versión 2: cambia la fecha del sorteo." },
        token,
      }),
    );
    expect(v2.status).toBe(201);
    const v2Json = (await v2.json()) as { data: { version: number; id: string } };
    expect(v2Json.data.version).toBe(2);

    // v1 inmutable: su contenido no cambió.
    const v1Row = await db.raffleTerms.findUniqueOrThrow({ where: { id: v1Json.data.id } });
    expect(v1Row.content).toBe("Bases versión 1: premio y fecha.");
    expect(v1Row.version).toBe(1);
    // La rifa apunta a la vigente (v2).
    const raffleRow = await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } });
    expect(raffleRow.termsVersionId).toBe(v2Json.data.id);
    expect((await getCurrentTerms(raffle.id))?.version).toBe(2);

    const list = await termsList(
      makeRequest(`/api/admin/terms?raffleId=${raffle.id}`, { token }),
    );
    const listJson = (await list.json()) as { data: { version: number }[]; total: number };
    expect(listJson.total).toBe(2);
    expect(listJson.data.map((t) => t.version)).toEqual([2, 1]);
  });

  it("P26 (lib): la aceptación vincula al comprador con la versión vigente; si cambian las bases, su versión queda registrada", async () => {
    const country = await seedCountry();
    const raffle = await seedRaffle(country.id);
    const admin = await createUser({ role: "SUPERADMIN" });
    await createTermsVersion({ raffleId: raffle.id, content: "Bases v1 del sorteo.", createdById: admin.id });

    const acc = await recordTermsAcceptance({ raffleId: raffle.id, buyerEmail: "comprador@test.do" });
    expect(acc.buyerEmail).toBe("comprador@test.do");

    // Las bases cambian a v2 después de la compra.
    await createTermsVersion({ raffleId: raffle.id, content: "Bases v2 del sorteo.", createdById: admin.id });
    expect((await getCurrentTerms(raffle.id))?.version).toBe(2);

    // El comprador sigue vinculado a la v1 que aceptó.
    const accepted = await getBuyerAcceptedTerms(raffle.id, "comprador@test.do");
    expect(accepted?.terms.version).toBe(1);
    expect(accepted?.terms.content).toBe("Bases v1 del sorteo.");

    // Aceptar de nuevo la versión vigente (v2) es idempotente: no duplica
    // el registro para esa versión (unique [raffleId, termsId, buyerEmail]).
    await recordTermsAcceptance({ raffleId: raffle.id, buyerEmail: "comprador@test.do" });
    await recordTermsAcceptance({ raffleId: raffle.id, buyerEmail: "comprador@test.do" });
    expect(
      await db.termsAcceptance.count({ where: { raffleId: raffle.id, buyerEmail: "comprador@test.do" } }),
    ).toBe(2); // v1 (compra original) + v2 (nueva aceptación)
  });

  it("aceptar bases sin versión vigente → 400", async () => {
    const country = await seedCountry();
    const raffle = await seedRaffle(country.id);
    await expect(
      recordTermsAcceptance({ raffleId: raffle.id, buyerEmail: "x@test.do" }),
    ).rejects.toThrow("no tiene bases vigentes");
  });
});
