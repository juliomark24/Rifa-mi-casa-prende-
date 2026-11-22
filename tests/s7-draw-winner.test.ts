// S7 — Sorteo commit-reveal + gestión del ganador (plan §2.5, §2.15).
// P7 (bloqueo por pendientes), P8 (doble sorteo), P14 (verificación pública),
// reproducibilidad independiente (lib vs scripts/verify-draw.mjs),
// determinismo, semilla CSPRNG, P23 (flujo del ganador hasta caso cerrado),
// y la regla 2: ganador publicado ≠ premio entregado.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as adminDrawDetail } from "../src/app/api/admin/draws/[id]/route";
import { POST as commit } from "../src/app/api/admin/raffles/[id]/draw/commit/route";
import { POST as execute } from "../src/app/api/admin/raffles/[id]/draw/execute/route";
import { GET as adminWinners } from "../src/app/api/admin/winners/route";
import { PATCH as winnerPatch } from "../src/app/api/admin/winners/[id]/route";
import { GET as publicDraw } from "../src/app/api/draws/[raffleId]/route";
import { GET as commitment } from "../src/app/api/draws/[raffleId]/commitment/route";
import { GET as publicWinners } from "../src/app/api/winners/route";
import { db } from "../src/lib/db";
import {
  checkDrawBlockers,
  computeDraw,
  freezeEligible,
  generateSeed,
  verifyDraw,
} from "../src/lib/draw";
import { cleanDb, createUser, loginToken, makeRequest } from "./helpers";

// Raíz del proyecto derivada de este archivo (no de process.cwd(): la
// suite puede correrse desde otro cwd para usar una BD propia).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_SCRIPT = join(ROOT, "scripts", "verify-draw.mjs");

let counter = 0;

async function seedCountry() {
  return db.country.create({
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
}

async function seedRaffle(status: "CERRADA" | "ACTIVA" | "EN_SORTEO" = "CERRADA", totalTickets = 100) {
  const country = await db.country.findFirstOrThrow({ where: { code: "DO" } });
  return db.raffle.create({
    data: {
      title: "Rifa S7",
      description: "d",
      prize: "premio",
      countryId: country.id,
      currency: "DOP",
      ticketPrice: 100,
      totalTickets,
      drawAt: new Date(Date.now() + 86400000),
      status,
    },
  });
}

/** Boleto VENDIDO con pedido CONFIRMADO + pago APROBADO (elegible). */
async function mkSoldTicket(raffleId: string, number: number) {
  counter += 1;
  const order = await db.order.create({
    data: {
      code: `ORD-S7-${counter}`,
      raffleId,
      buyerName: "Comprador Test",
      buyerEmail: `c${counter}@test.do`,
      paymentMethodCode: "MANUAL_TRANSFER",
      totalAmount: 100,
      currency: "DOP",
      status: "CONFIRMADO",
      idempotencyKey: `idem-s7-${counter}`,
    },
  });
  await db.payment.create({
    data: {
      orderId: order.id,
      amount: 100,
      currency: "DOP",
      methodCode: "MANUAL_TRANSFER",
      status: "APROBADO",
    },
  });
  return db.ticket.create({
    data: {
      raffleId,
      number,
      code: `PR-S7-${counter}-${number}`,
      status: "VENDIDO",
      orderId: order.id,
      buyerName: "Comprador Test",
      buyerEmail: `c${counter}@test.do`,
    },
  });
}

/** Boleto VENDIDO pero con pedido PENDIENTE (NO elegible). */
async function mkUnconfirmedSoldTicket(raffleId: string, number: number) {
  counter += 1;
  const order = await db.order.create({
    data: {
      code: `ORD-S7U-${counter}`,
      raffleId,
      buyerName: "Comprador Test",
      buyerEmail: `u${counter}@test.do`,
      paymentMethodCode: "MANUAL_TRANSFER",
      totalAmount: 100,
      currency: "DOP",
      status: "PENDIENTE",
      idempotencyKey: `idem-s7u-${counter}`,
    },
  });
  return db.ticket.create({
    data: {
      raffleId,
      number,
      code: `PR-S7U-${counter}-${number}`,
      status: "VENDIDO",
      orderId: order.id,
    },
  });
}

async function mkPendingOrder(raffleId: string) {
  counter += 1;
  return db.order.create({
    data: {
      code: `ORD-S7P-${counter}`,
      raffleId,
      buyerName: "Pendiente",
      buyerEmail: `p${counter}@test.do`,
      paymentMethodCode: "MANUAL_TRANSFER",
      totalAmount: 100,
      currency: "DOP",
      status: "PENDIENTE",
      idempotencyKey: `idem-s7p-${counter}`,
    },
  });
}

async function mkActiveReservation(raffleId: string, numbers: number[]) {
  return db.reservation.create({
    data: {
      raffleId,
      buyerEmail: "r@test.do",
      numbers,
      expiresAt: new Date(Date.now() + 600000),
      status: "ACTIVA",
    },
  });
}

async function adminToken() {
  const admin = await createUser({ role: "SUPERADMIN" });
  return loginToken(admin);
}

/** Rifa CERRADA con N boletos elegibles (números 1..N). */
async function raffleWithEligible(n: number) {
  const raffle = await seedRaffle("CERRADA", Math.max(n, 10));
  for (let i = 1; i <= n; i++) await mkSoldTicket(raffle.id, i);
  return raffle;
}

async function commitOk(raffleId: string, token: string) {
  const res = await commit(makeRequest(`/api/admin/raffles/${raffleId}/draw/commit`, { method: "POST", token }), {
    params: Promise.resolve({ id: raffleId }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    drawId: string;
    commitment: string;
    hashElegibles: string;
    totalElegibles: number;
  };
}

async function executeOk(raffleId: string, token: string) {
  const res = await execute(makeRequest(`/api/admin/raffles/${raffleId}/draw/execute`, { method: "POST", token }), {
    params: Promise.resolve({ id: raffleId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    drawId: string;
    seed: string;
    commitment: string;
    hashElegibles: string;
    eligibleSnapshot: string;
    winnerTicketNumber: number;
    winnerTicketCode: string;
    totalElegibles: number;
  };
}

/** Corre scripts/verify-draw.mjs con un JSON y devuelve {salida, código}. */
function runVerifyScript(input: unknown): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), "verify-draw-"));
  const file = join(dir, "sorteo.json");
  writeFileSync(file, JSON.stringify(input));
  try {
    const out = execFileSync("node", [VERIFY_SCRIPT, file], { encoding: "utf8" });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { out: String(e.stdout ?? err), code: e.status ?? 1 };
  }
}

describe("S7: congelamiento y elegibilidad", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedCountry();
  });

  it("freezeEligible: solo VENDIDO + pago confirmado; orden fijo y hash canónico", async () => {
    const raffle = await seedRaffle("CERRADA");
    await mkSoldTicket(raffle.id, 5);
    await mkSoldTicket(raffle.id, 2);
    await mkSoldTicket(raffle.id, 9);
    await mkUnconfirmedSoldTicket(raffle.id, 7); // VENDIDO pero pedido PENDIENTE → fuera
    await db.ticket.create({ data: { raffleId: raffle.id, number: 3, code: "PR-S7-RES-3", status: "RESERVADO" } });
    await db.ticket.create({ data: { raffleId: raffle.id, number: 4, code: "PR-S7-ANU-4", status: "ANULADO" } });
    const frozen = await freezeEligible(raffle.id);
    expect(frozen.numbers).toEqual([2, 5, 9]);
    expect(frozen.eligibleSnapshot).toBe("[2,5,9]");
    expect(frozen.totalElegibles).toBe(3);
    expect(frozen.hashElegibles).toMatch(/^[0-9a-f]{64}$/);
  });

  it("freezeEligible sin elegibles → 409; checkDrawBlockers cuenta pendientes", async () => {
    const raffle = await seedRaffle("CERRADA");
    await expect(freezeEligible(raffle.id)).rejects.toMatchObject({ status: 409 });
    await mkPendingOrder(raffle.id);
    await mkActiveReservation(raffle.id, [1]);
    const blockers = await checkDrawBlockers(raffle.id);
    expect(blockers.blocked).toBe(true);
    expect(blockers.pendingOrders).toBe(1);
    expect(blockers.activeReservations).toBe(1);
    expect(blockers.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("S7: commit (P7, P8)", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedCountry();
  });

  it("P7: commit bloqueado con pedido pendiente o reserva activa", async () => {
    const token = await adminToken();
    const raffle = await raffleWithEligible(3);
    await mkPendingOrder(raffle.id);
    const blocked = await commit(
      makeRequest(`/api/admin/raffles/${raffle.id}/draw/commit`, { method: "POST", token }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/sin resolver/);
    // Resolver el pedido → el commit pasa (la reserva sigue bloqueando).
    await db.order.updateMany({ where: { raffleId: raffle.id, status: "PENDIENTE" }, data: { status: "FALLIDO" } });
    await mkActiveReservation(raffle.id, [50]);
    const blocked2 = await commit(
      makeRequest(`/api/admin/raffles/${raffle.id}/draw/commit`, { method: "POST", token }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(blocked2.status).toBe(409);
    await db.reservation.updateMany({ where: { raffleId: raffle.id }, data: { status: "CANCELADA" } });
    const ok = await commitOk(raffle.id, token);
    expect(ok.totalElegibles).toBe(3);
    expect(ok.commitment).toMatch(/^[0-9a-f]{64}$/);
    // La rifa quedó EN_SORTEO (congelada: ya no está CERRADA).
    const after = await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } });
    expect(after.status).toBe("EN_SORTEO");
  });

  it("commit exige rifa CERRADA; rifa ACTIVA → 409; rifa inexistente → 404", async () => {
    const token = await adminToken();
    const activa = await seedRaffle("ACTIVA");
    await mkSoldTicket(activa.id, 1);
    const res = await commit(makeRequest(`/api/admin/raffles/${activa.id}/draw/commit`, { method: "POST", token }), {
      params: Promise.resolve({ id: activa.id }),
    });
    expect(res.status).toBe(409);
    const missing = await commit(makeRequest("/api/admin/raffles/nope/draw/commit", { method: "POST", token }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
  });

  it("commit sin elegibles → 409; cliente sin permiso → 403; sin auth → 401", async () => {
    const token = await adminToken();
    const empty = await seedRaffle("CERRADA");
    const res = await commit(makeRequest(`/api/admin/raffles/${empty.id}/draw/commit`, { method: "POST", token }), {
      params: Promise.resolve({ id: empty.id }),
    });
    expect(res.status).toBe(409);
    const raffle = await raffleWithEligible(2);
    const cliente = await createUser({ role: "CLIENTE" });
    const denied = await commit(
      makeRequest(`/api/admin/raffles/${raffle.id}/draw/commit`, { method: "POST", token: await loginToken(cliente) }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(denied.status).toBe(403);
    const anon = await commit(makeRequest(`/api/admin/raffles/${raffle.id}/draw/commit`, { method: "POST" }), {
      params: Promise.resolve({ id: raffle.id }),
    });
    expect(anon.status).toBe(401);
  });

  it("commitment público: 404 antes del commit; tras el commit NO revela la seed", async () => {
    const token = await adminToken();
    const raffle = await raffleWithEligible(4);
    const before = await commitment(makeRequest(`/api/draws/${raffle.id}/commitment`), {
      params: Promise.resolve({ raffleId: raffle.id }),
    });
    expect(before.status).toBe(404);
    const committed = await commitOk(raffle.id, token);
    const res = await commitment(makeRequest(`/api/draws/${raffle.id}/commitment`), {
      params: Promise.resolve({ raffleId: raffle.id }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.commitment).toBe(committed.commitment);
    expect(json.hashElegibles).toBe(committed.hashElegibles);
    expect(json.totalElegibles).toBe(4);
    expect(json.seedRevealed).toBe(false);
    expect(json).not.toHaveProperty("seed");
    expect(Object.keys(json)).not.toContain("seed");
    expect(JSON.stringify(json)).not.toContain('"seed":');
  });
});

describe("S7: execute (P7, P8, P14)", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedCountry();
  });

  it("P8: segundo commit y segundo execute → 409", async () => {
    const token = await adminToken();
    const raffle = await raffleWithEligible(5);
    await commitOk(raffle.id, token);
    const secondCommit = await commit(
      makeRequest(`/api/admin/raffles/${raffle.id}/draw/commit`, { method: "POST", token }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(secondCommit.status).toBe(409);
    await executeOk(raffle.id, token);
    const secondExecute = await execute(
      makeRequest(`/api/admin/raffles/${raffle.id}/draw/execute`, { method: "POST", token }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(secondExecute.status).toBe(409);
    expect(((await secondExecute.json()) as { error: string }).error).toMatch(/dos veces/);
  });

  it("execute sin compromiso previo → 404; P7: execute bloqueado si aparece un pendiente tras el commit", async () => {
    const token = await adminToken();
    const raffle = await raffleWithEligible(3);
    const noCommit = await execute(
      makeRequest(`/api/admin/raffles/${raffle.id}/draw/execute`, { method: "POST", token }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(noCommit.status).toBe(404);
    await commitOk(raffle.id, token);
    await mkPendingOrder(raffle.id); // pendiente creado tras congelar
    const blocked = await execute(
      makeRequest(`/api/admin/raffles/${raffle.id}/draw/execute`, { method: "POST", token }),
      { params: Promise.resolve({ id: raffle.id }) },
    );
    expect(blocked.status).toBe(409);
    await db.order.updateMany({ where: { raffleId: raffle.id, status: "PENDIENTE" }, data: { status: "FALLIDO" } });
    const ok = await executeOk(raffle.id, token);
    expect(ok.winnerTicketNumber).toBeGreaterThanOrEqual(1);
    expect(ok.winnerTicketNumber).toBeLessThanOrEqual(3);
  });

  it("execute publica ganador + abre el caso; rifa GANADOR_PUBLICADO; GET público 404 antes y 200 después", async () => {
    const token = await adminToken();
    const raffle = await raffleWithEligible(6);
    const before = await publicDraw(makeRequest(`/api/draws/${raffle.id}`), {
      params: Promise.resolve({ raffleId: raffle.id }),
    });
    expect(before.status).toBe(404);
    await commitOk(raffle.id, token);
    const stillBefore = await publicDraw(makeRequest(`/api/draws/${raffle.id}`), {
      params: Promise.resolve({ raffleId: raffle.id }),
    });
    expect(stillBefore.status).toBe(404); // comprometido pero no ejecutado: aún no hay resultado
    const executed = await executeOk(raffle.id, token);
    const raffleAfter = await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } });
    expect(raffleAfter.status).toBe("GANADOR_PUBLICADO");
    const wc = await db.winnerCase.findUniqueOrThrow({ where: { raffleId: raffle.id } });
    expect(wc.status).toBe("PENDIENTE_CONTACTO");
    expect(wc.winningTicketId).toBeTruthy();
    const res = await publicDraw(makeRequest(`/api/draws/${raffle.id}`), {
      params: Promise.resolve({ raffleId: raffle.id }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.seed).toBe(executed.seed);
    expect(json.commitment).toBe(executed.commitment);
    expect(json.winnerTicketNumber).toBe(executed.winnerTicketNumber);
    expect(json.winnerTicketCode).toBe(executed.winnerTicketCode);
    expect(json.eligibleSnapshot).toBe(executed.eligibleSnapshot);
    expect(json.algorithm).toBe("SHA256-CHAIN-v1");
  });

  it("P14: la verificación pública reproduce el ganador (lib y script)", async () => {
    const token = await adminToken();
    const raffle = await raffleWithEligible(10);
    await commitOk(raffle.id, token);
    const executed = await executeOk(raffle.id, token);
    // Vía librería.
    const v = verifyDraw({
      seed: executed.seed,
      eligibleSnapshot: executed.eligibleSnapshot,
      commitment: executed.commitment,
      winnerNumber: executed.winnerTicketNumber,
    });
    expect(v.valid).toBe(true);
    expect(v.commitmentMatches).toBe(true);
    // Vía endpoint público (los datos que ve cualquiera).
    const pub = (await (
      await publicDraw(makeRequest(`/api/draws/${raffle.id}`), { params: Promise.resolve({ raffleId: raffle.id }) })
    ).json()) as { seed: string; eligibleSnapshot: string; commitment: string; winnerTicketNumber: number };
    expect(
      verifyDraw({ seed: pub.seed, eligibleSnapshot: pub.eligibleSnapshot, commitment: pub.commitment, winnerNumber: pub.winnerTicketNumber }).valid,
    ).toBe(true);
    // Vía script independiente.
    const { out, code } = runVerifyScript({
      seed: executed.seed,
      eligibleSnapshot: executed.eligibleSnapshot,
      commitment: executed.commitment,
      winnerNumber: executed.winnerTicketNumber,
    });
    expect(code).toBe(0);
    expect(out).toContain("VERIFICADO");
    // Y el script rechaza un ganador falso.
    const bad = runVerifyScript({
      seed: executed.seed,
      eligibleSnapshot: executed.eligibleSnapshot,
      commitment: executed.commitment,
      winnerNumber: executed.winnerTicketNumber === 1 ? 2 : 1,
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("NO COINCIDE");
  });

  it("GET /api/admin/draws/[id]: admin ve el detalle; sin seed antes de ejecutar; cliente 403", async () => {
    const token = await adminToken();
    const raffle = await raffleWithEligible(3);
    const committed = await commitOk(raffle.id, token);
    const pre = await adminDrawDetail(makeRequest(`/api/admin/draws/${committed.drawId}`, { token }), {
      params: Promise.resolve({ id: committed.drawId }),
    });
    expect(pre.status).toBe(200);
    const preJson = (await pre.json()) as { data: Record<string, unknown> };
    expect(preJson.data.seed).toBeNull();
    expect(preJson.data.commitment).toBe(committed.commitment);
    await executeOk(raffle.id, token);
    const post = await adminDrawDetail(makeRequest(`/api/admin/draws/${committed.drawId}`, { token }), {
      params: Promise.resolve({ id: committed.drawId }),
    });
    const postJson = (await post.json()) as { data: Record<string, unknown> };
    expect(typeof postJson.data.seed).toBe("string");
    const cliente = await createUser({ role: "CLIENTE" });
    const denied = await adminDrawDetail(
      makeRequest(`/api/admin/draws/${committed.drawId}`, { token: await loginToken(cliente) }),
      { params: Promise.resolve({ id: committed.drawId }) },
    );
    expect(denied.status).toBe(403);
    const missing = await adminDrawDetail(makeRequest("/api/admin/draws/nope", { token }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("S7: determinismo, CSPRNG y reproducibilidad independiente", () => {
  it("determinismo: misma seed + misma lista = mismo ganador siempre", () => {
    const seed = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const a = computeDraw([9, 1, 5, 3], seed);
    const b = computeDraw([3, 5, 1, 9], seed);
    expect(a.winnerNumber).toBe(b.winnerNumber);
    expect(a.commitment).toBe(b.commitment);
    expect(a.eligibleSnapshot).toBe("[1,3,5,9]");
  });

  it("semilla CSPRNG: 100 semillas únicas, formato hex 64; el código no usa Math.random", () => {
    const seeds = new Set(Array.from({ length: 100 }, () => generateSeed()));
    expect(seeds.size).toBe(100);
    for (const s of seeds) expect(s).toMatch(/^[0-9a-f]{64}$/);
    const drawSrc = readFileSync(join(ROOT, "src", "lib", "draw.ts"), "utf8");
    expect(drawSrc).not.toContain("Math.random");
    const scriptSrc = readFileSync(VERIFY_SCRIPT, "utf8");
    expect(scriptSrc).not.toContain("Math.random");
    expect(scriptSrc).toContain("node:crypto");
  });

  it("reproducibilidad independiente lib vs script: 1, 2 y 10.000 elegibles", () => {
    const cases: Array<{ numbers: number[]; seed: string }> = [
      { numbers: [7], seed: "11".repeat(32) },
      { numbers: [4, 9], seed: "22".repeat(32) },
      { numbers: Array.from({ length: 10000 }, (_, i) => i + 1), seed: "33".repeat(32) },
    ];
    for (const c of cases) {
      const lib = computeDraw(c.numbers, c.seed);
      const { out, code } = runVerifyScript({
        seed: lib.seed,
        eligibleSnapshot: lib.eligibleSnapshot,
        commitment: lib.commitment,
        winnerNumber: lib.winnerNumber,
      });
      expect(code).toBe(0);
      expect(out).toContain("VERIFICADO");
      expect(out).toContain(`#${lib.winnerNumber}`);
      // La lista desordenada también reproduce (el script canoniza).
      const shuffled = [...c.numbers].reverse();
      const { code: code2 } = runVerifyScript({
        seed: lib.seed,
        eligible: shuffled,
        commitment: lib.commitment,
        winnerNumber: lib.winnerNumber,
      });
      expect(code2).toBe(0);
    }
  });

  it("el script rechaza semilla o lista alteradas", () => {
    const lib = computeDraw([1, 2, 3, 4, 5], "44".repeat(32));
    const badSeed = runVerifyScript({
      seed: "00".repeat(32),
      eligibleSnapshot: lib.eligibleSnapshot,
      commitment: lib.commitment,
      winnerNumber: lib.winnerNumber,
    });
    expect(badSeed.code).toBe(1);
    expect(badSeed.out).toContain("NO COINCIDE");
    const badList = runVerifyScript({
      seed: lib.seed,
      eligibleSnapshot: "[1,2,3,4,6]",
      commitment: lib.commitment,
      winnerNumber: lib.winnerNumber,
    });
    expect(badList.code).toBe(1);
  });
});

describe("S7: gestión del ganador (P23 + regla 2)", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedCountry();
  });

  const DELIVERY_EVIDENCE = {
    photos: ["https://ejemplo.do/entrega-foto-1.jpg"],
    acta: "Acta de entrega firmada",
    deliveryDate: "2026-11-21",
    responsible: "Admin Prende Rifas",
  };

  async function setupExecuted() {
    const token = await adminToken();
    const raffle = await raffleWithEligible(5);
    await commitOk(raffle.id, token);
    await executeOk(raffle.id, token);
    const wc = await db.winnerCase.findUniqueOrThrow({ where: { raffleId: raffle.id } });
    return { token, raffle, wc };
  }

  async function patchCase(caseId: string, token: string, body: unknown) {
    return winnerPatch(makeRequest(`/api/admin/winners/${caseId}`, { method: "PATCH", body, token }), {
      params: Promise.resolve({ id: caseId }),
    });
  }

  it("regla 2: ganador publicado ≠ entregado — tras ejecutar, el caso sigue abierto y la rifa NO está finalizada", async () => {
    const { raffle, wc } = await setupExecuted();
    expect(wc.status).toBe("PENDIENTE_CONTACTO");
    const raffleRow = await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } });
    expect(raffleRow.status).toBe("GANADOR_PUBLICADO");
    expect(raffleRow.status).not.toBe("FINALIZADA");
    const list = await publicWinners(makeRequest("/api/winners"));
    expect(list.status).toBe(200);
    const json = (await list.json()) as { data: Array<{ winnerTicketNumber: number; winnerName: unknown }>; total: number };
    expect(json.total).toBe(1);
    expect(json.data[0].winnerTicketNumber).toBeGreaterThanOrEqual(1);
    expect(json.data[0].winnerName).toBeNull(); // sin datos personales en público
  });

  it("P23: flujo completo hasta CASO_CERRADO con evidencia; la rifa pasa a FINALIZADA", async () => {
    const { token, raffle, wc } = await setupExecuted();
    const steps = [
      { status: "CONTACTADO", note: "Contactado por WhatsApp", contactChannel: "WHATSAPP" },
      { status: "VERIFICACION", note: "Identidad verificada con cédula" },
      { status: "PREMIO_ACEPTADO", note: "Ganador acepta el premio" },
      { status: "ENTREGA_COORDINADA", note: "Entrega coordinada para el sábado" },
      { status: "ENTREGADO", note: "Premio entregado en mano", evidence: DELIVERY_EVIDENCE },
      { status: "CASO_CERRADO", note: "Caso cerrado con acta firmada" },
    ] as const;
    for (const step of steps) {
      const res = await patchCase(wc.id, token, step);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { status: string } }).data.status).toBe(step.status);
    }
    const closed = await db.winnerCase.findUniqueOrThrow({ where: { id: wc.id } });
    expect(closed.status).toBe("CASO_CERRADO");
    expect(closed.notes).toContain("WhatsApp");
    const log = closed.contactLog as Array<{ channel: string }>;
    expect(log.some((e) => e.channel === "WHATSAPP")).toBe(true);
    const raffleRow = await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } });
    expect(raffleRow.status).toBe("FINALIZADA");
  });

  it("P23: no se puede cerrar sin evidencia de entrega; saltarse pasos y retroceder → 409", async () => {
    const { token, wc } = await setupExecuted();
    // Saltarse pasos: de PENDIENTE_CONTACTO directo a ENTREGADO.
    const skip = await patchCase(wc.id, token, { status: "ENTREGADO" });
    expect(skip.status).toBe(409);
    // Avanzar hasta ENTREGADO y tratar de cerrar sin evidencia.
    for (const status of ["CONTACTADO", "VERIFICACION", "PREMIO_ACEPTADO", "ENTREGA_COORDINADA", "ENTREGADO"] as const) {
      expect((await patchCase(wc.id, token, { status })).status).toBe(200);
    }
    const noEvidence = await patchCase(wc.id, token, { status: "CASO_CERRADO" });
    expect(noEvidence.status).toBe(409);
    expect(((await noEvidence.json()) as { error: string }).error).toMatch(/evidencia de entrega/);
    // Con evidencia sí cierra; y un caso cerrado es inmutable.
    const ok = await patchCase(wc.id, token, { status: "CASO_CERRADO", evidence: DELIVERY_EVIDENCE });
    expect(ok.status).toBe(200);
    const afterClose = await patchCase(wc.id, token, { status: "ENTREGADO", note: "reabrir" });
    expect(afterClose.status).toBe(409);
  });

  it("P23: ganador que no responde — procedimiento de las bases, caso abierto, rifa sin finalizar", async () => {
    const { token, raffle, wc } = await setupExecuted();
    const res = await patchCase(wc.id, token, {
      outcome: "SIN_RESPUESTA",
      note: "3 intentos de contacto sin respuesta",
      contactChannel: "WHATSAPP",
      deadlineDays: 7,
    });
    expect(res.status).toBe(200);
    const row = await db.winnerCase.findUniqueOrThrow({ where: { id: wc.id } });
    expect(row.status).toBe("PENDIENTE_CONTACTO"); // el caso sigue abierto
    expect(row.notes).toContain("PROCEDIMIENTO");
    expect(row.notes).toContain("no responde");
    expect(row.notes).toContain("7 día(s)");
    const raffleRow = await db.raffle.findUniqueOrThrow({ where: { id: raffle.id } });
    expect(raffleRow.status).toBe("GANADOR_PUBLICADO");
    expect(raffleRow.status).not.toBe("FINALIZADA");
  });

  it("procedimientos: renuncia y no elegible quedan registrados sin cerrar; outcome sin nota → 400", async () => {
    const { token, wc } = await setupExecuted();
    const renuncia = await patchCase(wc.id, token, {
      outcome: "RENUNCIA",
      note: "El ganador renuncia por escrito al premio",
    });
    expect(renuncia.status).toBe(200);
    const row = await db.winnerCase.findUniqueOrThrow({ where: { id: wc.id } });
    expect(row.status).toBe("PENDIENTE_CONTACTO");
    expect(row.notes).toContain("renuncia");
    const noNote = await patchCase(wc.id, token, { outcome: "NO_ELEGIBLE" });
    expect(noNote.status).toBe(400);
    const badOutcome = await patchCase(wc.id, token, { outcome: "INVENTADO", note: "x" });
    expect(badOutcome.status).toBe(400);
  });

  it("GET /api/admin/winners: lista con datos del boleto; filtro por estado; cliente 403", async () => {
    const { token, wc } = await setupExecuted();
    const res = await adminWinners(makeRequest("/api/admin/winners", { token }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ id: string; status: string; ticketNumber: number | null; raffleTitle: string }>;
      total: number;
    };
    expect(json.total).toBe(1);
    expect(json.data[0].id).toBe(wc.id);
    expect(json.data[0].ticketNumber).toBeGreaterThanOrEqual(1);
    expect(json.data[0].raffleTitle).toBe("Rifa S7");
    const filtered = await adminWinners(makeRequest("/api/admin/winners?status=ENTREGADO", { token }));
    expect(((await filtered.json()) as { total: number }).total).toBe(0);
    const cliente = await createUser({ role: "CLIENTE" });
    const denied = await adminWinners(makeRequest("/api/admin/winners", { token: await loginToken(cliente) }));
    expect(denied.status).toBe(403);
  });
});
