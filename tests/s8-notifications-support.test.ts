// S8 — Notificaciones + soporte + monitoreo (plan §2.16, §2.17, §2.19).
// P24 (notificación fallida no rompe la compra), P25 (reclamación
// "pagué y no recibí mi boleto" genera ticket enlazado), P10 (backup
// restaurado = datos correctos), jobs resilientes (re-ejecución sin
// duplicar, recuperación tras reinicio, anti-solape) y alertas
// (pago sin boleto → alerta activa).
//
// NOTA: tests/setup.ts fija DATABASE_URL a prisma/test.db; la BD de
// test de esta suite es esa (ver reporte S8). BACKUP_DIR se apunta a
// un temporal por test para no ensuciar ./backups.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as health } from "../src/app/api/admin/health/route";
import { GET as adminNotifications } from "../src/app/api/admin/notifications/route";
import { GET as adminTickets, } from "../src/app/api/admin/support-tickets/route";
import { PATCH as supportPatch } from "../src/app/api/admin/support-tickets/[id]/route";
import { GET as supportStats } from "../src/app/api/admin/support-tickets/stats/route";
import { GET as mine } from "../src/app/api/support-tickets/mine/route";
import { POST as createTicket } from "../src/app/api/support-tickets/route";
import { db } from "../src/lib/db";
import { getLastJobRun, recoverStaleJobRuns, runAllJobs, runJob, runJobByName } from "../src/lib/jobs";
import { checkAlerts, evaluateAndRecordAlerts, getSystemHealth } from "../src/lib/monitoring";
import {
  dispatchNotification,
  dispatchPendingNotifications,
  enqueueNotification,
  MAX_NOTIFICATION_ATTEMPTS,
  queueNotificationSafe,
} from "../src/lib/notifications";
import { cleanDb, createUser, loginToken, makeRequest } from "./helpers";

function sourceDbPath(): string {
  const url = process.env.DATABASE_URL ?? "";
  const rel = url.startsWith("file:") ? url.slice("file:".length) : "prisma/test.db";
  return path.resolve(process.cwd(), rel);
}

async function seedCountryRaffle(opts: { drawAt?: Date; status?: "ACTIVA" | "PROGRAMADA" } = {}) {
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
      title: "Rifa test S8",
      description: "d",
      prize: "premio",
      countryId: country.id,
      currency: "DOP",
      ticketPrice: 100,
      totalTickets: 10,
      drawAt: opts.drawAt ?? new Date(Date.now() + 86400000),
      status: opts.status ?? "ACTIVA",
    },
  });
  return { country, raffle };
}

let orderCounter = 0;
async function seedOrder(raffleId: string, opts: { status?: "PENDIENTE" | "CONFIRMADO"; buyerEmail?: string } = {}) {
  orderCounter += 1;
  return db.order.create({
    data: {
      code: `ORD-S8-${orderCounter}`,
      raffleId,
      buyerName: "Cliente Test",
      buyerEmail: opts.buyerEmail ?? "cliente@test.do",
      paymentMethodCode: "MANUAL_TRANSFER",
      totalAmount: 1000,
      currency: "DOP",
      status: opts.status ?? "CONFIRMADO",
      idempotencyKey: `idem-s8-${orderCounter}-${Date.now()}`,
    },
  });
}

const failingSender = async () => ({ ok: false as const, error: "SMTP simulado caído" });
const okSender = async () => ({ ok: true as const });

let backupDir: string;
const origResendKey = process.env.RESEND_API_KEY;
const origBackupDir = process.env.BACKUP_DIR;

beforeEach(async () => {
  await cleanDb();
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "prende-backup-s8-"));
  process.env.BACKUP_DIR = backupDir;
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  if (origResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = origResendKey;
  if (origBackupDir === undefined) delete process.env.BACKUP_DIR;
  else process.env.BACKUP_DIR = origBackupDir;
  fs.rmSync(backupDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ P24
describe("P24 — notificación fallida no rompe la compra", () => {
  it("reintentos con backoff, fallo registrado y compra intacta", async () => {
    const { raffle } = await seedCountryRaffle();
    const order = await seedOrder(raffle.id);
    process.env.RESEND_API_KEY = "test-key";
    const n = await enqueueNotification({
      event: "pago_confirmado",
      channel: "EMAIL",
      recipient: "cliente@test.do",
      data: { buyerName: "Cliente Test", orderCode: order.code, totalAmount: 1000, currency: "DOP" },
      dedupeKey: `pago:${order.code}`,
    });
    // Primer intento fallido: queda PENDIENTE, con el error registrado.
    const after1 = await dispatchNotification(n.id, { emailSender: failingSender });
    expect(after1?.status).toBe("PENDIENTE");
    expect(after1?.attempts).toBe(1);
    expect(after1?.lastError).toContain("SMTP simulado");
    // Sin force, el backoff impide reintentar de inmediato.
    const skipped = await dispatchNotification(n.id, { emailSender: failingSender });
    expect(skipped?.attempts).toBe(1);
    // Reintentos forzados hasta agotar: termina FALLIDO, nunca rompe nada.
    for (let i = 0; i < MAX_NOTIFICATION_ATTEMPTS - 1; i++) {
      await dispatchNotification(n.id, { emailSender: failingSender, force: true });
    }
    const final = await db.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(final.status).toBe("FALLIDO");
    expect(final.attempts).toBe(MAX_NOTIFICATION_ATTEMPTS);
    // La compra sigue intacta: el fallo de notificación no la tocó.
    const orderAfter = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfter.status).toBe("CONFIRMADO");
  });

  it("sin RESEND_API_KEY el correo queda PENDIENTE sin contar intento", async () => {
    const n = await enqueueNotification({
      event: "pago_confirmado",
      channel: "EMAIL",
      recipient: "cliente@test.do",
      data: { orderCode: "ORD-X" },
    });
    const after = await dispatchNotification(n.id, { emailSender: okSender });
    expect(after?.status).toBe("PENDIENTE");
    expect(after?.attempts).toBe(0);
  });

  it("WEB se entrega de inmediato; WhatsApp queda NO_CONFIGURADO (Fase 2)", async () => {
    const web = await enqueueNotification({ event: "sorteo_proximo", channel: "WEB", recipient: "cliente@test.do", data: {} });
    const webAfter = await dispatchNotification(web.id);
    expect(webAfter?.status).toBe("ENTREGADO");
    expect(webAfter?.sentAt).not.toBeNull();

    const wa = await enqueueNotification({ event: "pago_confirmado", channel: "WHATSAPP", recipient: "+18090000000", data: {} });
    const waAfter = await dispatchNotification(wa.id);
    expect(waAfter?.status).toBe("FALLIDO");
    expect(waAfter?.lastError).toContain("NO_CONFIGURADO");
  });

  it("dedupe: un evento = una notificación por destinatario y canal", async () => {
    const input = {
      event: "pago_confirmado" as const,
      channel: "EMAIL" as const,
      recipient: "cliente@test.do",
      data: { orderCode: "ORD-DUP" },
      dedupeKey: "pago:ORD-DUP",
    };
    const a = await enqueueNotification(input);
    const b = await enqueueNotification(input);
    expect(b.id).toBe(a.id);
    expect(await db.notification.count({ where: { event: "pago_confirmado" } })).toBe(1);
    // Otra ocurrencia (otro pedido) sí genera otra notificación.
    await enqueueNotification({ ...input, dedupeKey: "pago:ORD-OTRO" });
    expect(await db.notification.count({ where: { event: "pago_confirmado" } })).toBe(2);
  });

  it("queueNotificationSafe nunca lanza y el dispatch no tumba la cola", async () => {
    const row = await queueNotificationSafe({
      event: "reembolso",
      channel: "EMAIL",
      recipient: "cliente@test.do",
      data: { orderCode: "ORD-SAFE", totalAmount: 500, currency: "DOP" },
    });
    expect(row).not.toBeNull();
    const res = await dispatchPendingNotifications({ emailSender: failingSender, force: true });
    expect(res.processed).toBe(1);
    expect(res.failed + res.skippedNoConfig).toBeGreaterThanOrEqual(0);
  });
});

// ------------------------------------------------------------------ P25
describe("P25 — reclamación 'pagué y no recibí mi boleto' genera ticket", () => {
  async function seedPagoSinBoleto() {
    const { raffle } = await seedCountryRaffle();
    const order = await seedOrder(raffle.id);
    const payment = await db.payment.create({
      data: {
        orderId: order.id,
        providerCode: "MANUAL_TRANSFER",
        amount: 1000,
        currency: "DOP",
        methodCode: "MANUAL_TRANSFER",
        status: "APROBADO",
      },
    });
    return { raffle, order, payment };
  }

  it("ticket con número, estado, prioridad, responsable, plazo y contexto", async () => {
    const { order } = await seedPagoSinBoleto();
    const buyer = await createUser({ role: "CLIENTE", email: "cliente@test.do" });
    const admin = await createUser({ role: "SUPERADMIN", email: "admin@test.do" });
    const adminToken = await loginToken(admin);

    const res = await createTicket(
      makeRequest("/api/support-tickets", {
        method: "POST",
        body: {
          type: "PAGO_SIN_BOLETO",
          buyerEmail: "cliente@test.do",
          orderCode: order.code,
          message: "Pagué y no recibí mi boleto",
        },
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ticket: { number: string; status: string } };
    expect(json.ticket.number).toBe("TKT-000001");
    expect(json.ticket.status).toBe("ABIERTO");

    // Lista admin: enlazado al pedido, con plazo (ALTA = 24 h).
    const list = await adminTickets(
      makeRequest("/api/admin/support-tickets?type=PAGO_SIN_BOLETO", { token: adminToken }),
    );
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as {
      data: Array<{ number: string; order: { code: string } | null; dueAt: string; slaHours: number; priority: string }>;
      total: number;
    };
    expect(listJson.total).toBe(1);
    expect(listJson.data[0].order?.code).toBe(order.code);
    expect(listJson.data[0].priority).toBe("ALTA");
    expect(listJson.data[0].slaHours).toBe(24);
    expect(new Date(listJson.data[0].dueAt).getTime()).toBeGreaterThan(Date.now());

    // El cliente ve su ticket en /mine.
    const mineRes = await mine(makeRequest("/api/support-tickets/mine", { token: await loginToken(buyer) }));
    const mineJson = (await mineRes.json()) as { data: Array<{ number: string }> };
    expect(mineJson.data.map((t) => t.number)).toContain("TKT-000001");

    // El admin asigna responsable, pasa a EN_REVISION y ve pedido + pago.
    const ticket = await db.supportTicket.findFirstOrThrow();
    const patched = await supportPatch(
      makeRequest(`/api/admin/support-tickets/${ticket.id}`, {
        method: "PATCH",
        body: { status: "EN_REVISION", assignee: admin.id, note: "Revisando el pago" },
        token: adminToken,
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(patched.status).toBe(200);
    const patchedJson = (await patched.json()) as {
      data: {
        status: string;
        ownerId: string;
        dueAt: string;
        context: { order: { code: string }; payments: Array<{ status: string }>; tickets: unknown[] };
      };
    };
    expect(patchedJson.data.status).toBe("EN_REVISION");
    expect(patchedJson.data.ownerId).toBe(admin.id);
    expect(patchedJson.data.context.order.code).toBe(order.code);
    expect(patchedJson.data.context.payments[0].status).toBe("APROBADO");
    expect(patchedJson.data.dueAt).toBeTruthy();

    // Transición no permitida: CERRADO → RESUELTO responde 409.
    const closed = await supportPatch(
      makeRequest(`/api/admin/support-tickets/${ticket.id}`, {
        method: "PATCH",
        body: { status: "CERRADO" },
        token: adminToken,
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(closed.status).toBe(200);
    const bad = await supportPatch(
      makeRequest(`/api/admin/support-tickets/${ticket.id}`, {
        method: "PATCH",
        body: { status: "RESUELTO" },
        token: adminToken,
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(bad.status).toBe(409);
    // Reapertura posible: CERRADO → ABIERTO limpia resolvedAt.
    const reopened = await supportPatch(
      makeRequest(`/api/admin/support-tickets/${ticket.id}`, {
        method: "PATCH",
        body: { status: "ABIERTO" },
        token: adminToken,
      }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    expect(reopened.status).toBe(200);
    const reopenedJson = (await reopened.json()) as { data: { resolvedAt: string | null } };
    expect(reopenedJson.data.resolvedAt).toBeNull();
  });

  it("stats: abiertos, por tipo y tiempo medio de resolución", async () => {
    const { order } = await seedPagoSinBoleto();
    const admin = await createUser({ role: "SUPERADMIN", email: "admin@test.do" });
    const adminToken = await loginToken(admin);
    await createTicket(
      makeRequest("/api/support-tickets", {
        method: "POST",
        body: { type: "PAGO_SIN_BOLETO", buyerEmail: "cliente@test.do", orderCode: order.code, message: "Pagué y no recibí mi boleto" },
      }),
    );
    const before = (await (await supportStats(makeRequest("/api/admin/support-tickets/stats", { token: adminToken }))).json()) as {
      open: number;
      byType: Record<string, number>;
      avgResolutionHours: number | null;
    };
    expect(before.open).toBe(1);
    expect(before.byType.PAGO_SIN_BOLETO).toBe(1);
    expect(before.avgResolutionHours).toBeNull();

    const ticket = await db.supportTicket.findFirstOrThrow();
    await supportPatch(
      makeRequest(`/api/admin/support-tickets/${ticket.id}`, { method: "PATCH", body: { status: "EN_REVISION" }, token: adminToken }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    await supportPatch(
      makeRequest(`/api/admin/support-tickets/${ticket.id}`, { method: "PATCH", body: { status: "RESUELTO" }, token: adminToken }),
      { params: Promise.resolve({ id: ticket.id }) },
    );
    const after = (await (await supportStats(makeRequest("/api/admin/support-tickets/stats", { token: adminToken }))).json()) as {
      open: number;
      avgResolutionHours: number | null;
    };
    expect(after.open).toBe(0);
    expect(typeof after.avgResolutionHours).toBe("number");
  });
});

// ------------------------------------------------------------------ P10
describe("P10 — backup restaurado = datos correctos", () => {
  it("backup + restore-test.mjs verifican ventas, boletos, comisiones y saldos", async () => {
    const { raffle } = await seedCountryRaffle();
    const affiliate = await createUser({ role: "AFILIADO", email: "afi@test.do" });
    const order = await seedOrder(raffle.id);
    const ticket = await db.ticket.create({
      data: {
        raffleId: raffle.id,
        number: 7,
        code: "PR-TEST-000007",
        status: "VENDIDO",
        orderId: order.id,
        buyerName: "Cliente Test",
        buyerEmail: "cliente@test.do",
        affiliateId: affiliate.id,
      },
    });
    await db.payment.create({
      data: { orderId: order.id, providerCode: "MANUAL_TRANSFER", amount: 1000, currency: "DOP", methodCode: "MANUAL_TRANSFER", status: "APROBADO" },
    });
    await db.commission.create({
      data: { affiliateId: affiliate.id, orderId: order.id, ticketId: ticket.id, amount: 100, currency: "DOP", status: "RETAINED" },
    });
    await db.ledgerEntry.create({ data: { type: "VENTA", amount: 1000, currency: "DOP", refType: "Order", refId: order.id } });
    await db.ledgerEntry.create({ data: { type: "COMISION", amount: 100, currency: "DOP", refType: "Order", refId: order.id } });

    const run = await runJobByName("backup-daily");
    expect(run.status).toBe("COMPLETED");
    expect((run.result as { verified?: boolean })?.verified).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const backupDayDir = path.join(backupDir, today);
    expect(fs.existsSync(path.join(backupDayDir, "prende-rifas.db"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDayDir, "manifest.json"), "utf8")) as { sha256: string };
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);

    const out = execFileSync(
      "node",
      ["scripts/restore-test.mjs", "--backup", backupDayDir, "--source", sourceDbPath()],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(out).toContain("PASS");
    expect(out).not.toContain("FAIL");
    expect(out).toContain("restaurado == origen: ticketsSold");
  });
});

// ------------------------------------------------------- jobs resilientes
describe("jobs resilientes (regla 3)", () => {
  it("runJobByName despacha notificaciones y tolera módulos que faltan (S4/S5)", async () => {
    await enqueueNotification({ event: "sorteo_proximo", channel: "WEB", recipient: "c@test.do", data: {} });
    const dispatched = await runJobByName("notification-dispatch");
    expect(dispatched.status).toBe("COMPLETED");
    const n = await db.notification.findFirstOrThrow();
    expect(n.status).toBe("ENTREGADO");

    // S4 ya creó release-expired-reservations (exporta run()): el runner
    // lo descubre y lo ejecuta; reconcile-provider (S5) ya existe y completa.
    const s4 = await runJobByName("release-expired-reservations");
    expect(s4.status).toBe("COMPLETED");
    const reconciled = await runJobByName("reconcile-provider");
    expect(reconciled.status).toBe("COMPLETED");
    expect(reconciled.missing).toBeFalsy();
  });

  it("runAllJobs completa los de S8 sin tumbarse por los que faltan", async () => {
    const summary = await runAllJobs();
    expect(summary.completed).toContain("notification-dispatch");
    expect(summary.completed).toContain("backup-daily");
    expect(summary.completed).toContain("recovery-sweep");
    expect(summary.completed).toContain("reconcile-provider");
    expect(summary.completed).toContain("retention-sweep");
    expect(summary.failed).toEqual([]);
    expect(summary.skipped.map((s) => s.job)).not.toContain("reconcile-provider");
    expect(summary.skipped.map((s) => s.job)).not.toContain("release-expired-reservations");
  });

  it("anti-solape: una ejecución RUNNING reciente hace skip sin duplicar", async () => {
    await db.jobRun.create({ data: { job: "retention-sweep", status: "RUNNING" } });
    const res = await runJobByName("retention-sweep");
    expect(res.skipped).toBe(true);
    expect(await db.jobRun.count({ where: { job: "retention-sweep" } })).toBe(1);
  });

  it("recuperación tras reinicio: RUNNING huérfana → FAILED y la siguiente retoma", async () => {
    await db.jobRun.create({
      data: { job: "retention-sweep", status: "RUNNING", startedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    const recovered = await recoverStaleJobRuns("retention-sweep");
    expect(recovered).toBe(1);
    const stale = await db.jobRun.findFirstOrThrow({ where: { job: "retention-sweep" } });
    expect(stale.status).toBe("FAILED");
    expect(stale.error).toContain("huérfana");
    const res = await runJobByName("retention-sweep");
    expect(res.status).toBe("COMPLETED");
    // runJob también recupera huérfanos solo: simular reinicio a mitad de un job que falla.
    await expect(runJob("failing-s8", async () => { throw new Error("boom-s8"); })).rejects.toThrow("boom-s8");
    const last = await getLastJobRun("failing-s8");
    expect(last?.status).toBe("FAILED");
  });

  it("recovery-sweep: expira solicitudes y crea UN solo caso por pago sin boleto", async () => {
    const user = await createUser({ role: "SUPERADMIN", email: "rec@test.do" });
    await db.recoveryRequest.create({
      data: { userId: user.id, tokenHash: "hash1", status: "PENDIENTE", expiresAt: new Date(Date.now() - 1000) },
    });
    await db.recoveryRequest.create({
      data: {
        userId: user.id,
        tokenHash: "hash2",
        status: "APROBADO",
        expiresAt: new Date(Date.now() + 3600000),
        resetCodeExpiresAt: new Date(Date.now() - 1000),
      },
    });
    const { raffle } = await seedCountryRaffle();
    const order = await seedOrder(raffle.id);
    await db.payment.create({
      data: { orderId: order.id, providerCode: "MANUAL_TRANSFER", amount: 1000, currency: "DOP", methodCode: "MANUAL_TRANSFER", status: "APROBADO" },
    });
    const r1 = await runJobByName("recovery-sweep");
    expect(r1.status).toBe("COMPLETED");
    expect((r1.result as { recoveryRequestsExpired?: number }).recoveryRequestsExpired).toBe(2);
    expect((r1.result as { reconciliationCasesCreated?: number }).reconciliationCasesCreated).toBe(1);
    const r2 = await runJobByName("recovery-sweep");
    expect((r2.result as { reconciliationCasesCreated?: number }).reconciliationCasesCreated).toBe(0);
    expect(await db.reconciliationCase.count()).toBe(1);
    expect(await db.recoveryRequest.count({ where: { status: "EXPIRADO" } })).toBe(2);
  });

  it("retention-sweep: libera la comisión retenida vencida una sola vez", async () => {
    const { raffle } = await seedCountryRaffle({ drawAt: new Date(Date.now() - 86400000) });
    const affiliate = await createUser({ role: "AFILIADO", email: "afi2@test.do" });
    const order = await seedOrder(raffle.id);
    const commission = await db.commission.create({
      data: {
        affiliateId: affiliate.id,
        orderId: order.id,
        amount: 100,
        currency: "DOP",
        status: "RETAINED",
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      },
    });
    const r1 = await runJobByName("retention-sweep");
    expect(r1.status).toBe("COMPLETED");
    expect((r1.result as { released?: number }).released).toBe(1);
    expect((await db.commission.findUniqueOrThrow({ where: { id: commission.id } })).status).toBe("AVAILABLE");
    const r2 = await runJobByName("retention-sweep");
    expect((r2.result as { released?: number }).released).toBe(0);
  });
});

// ------------------------------------------------------------------ alertas
describe("alertas (§2.19) y monitoreo", () => {
  it("pago sin boleto y reserva sin liberar activan sus alertas", async () => {
    const { raffle } = await seedCountryRaffle();
    const order = await seedOrder(raffle.id);
    await db.payment.create({
      data: { orderId: order.id, providerCode: "MANUAL_TRANSFER", amount: 1000, currency: "DOP", methodCode: "MANUAL_TRANSFER", status: "APROBADO" },
    });
    await db.reservation.create({
      data: { raffleId: raffle.id, buyerEmail: "c@test.do", numbers: [1, 2], expiresAt: new Date(Date.now() - 10 * 60 * 1000), status: "ACTIVA" },
    });
    const alerts = await checkAlerts();
    const types = alerts.map((a) => a.type);
    expect(types).toContain("pagos_sin_boletos");
    expect(types).toContain("reservas_sin_liberar");
    expect(alerts.find((a) => a.type === "pagos_sin_boletos")?.severity).toBe("alta");
  });

  it("backup fallido activa backups_fallidos; evaluateAndRecordAlerts lo audita", async () => {
    await db.jobRun.create({
      data: { job: "backup-daily", status: "FAILED", finishedAt: new Date(), error: "disco lleno (simulado)" },
    });
    const alerts = await checkAlerts();
    expect(alerts.map((a) => a.type)).toContain("backups_fallidos");
    expect(alerts.find((a) => a.type === "backups_fallidos")?.severity).toBe("alta");
    const recorded = await evaluateAndRecordAlerts();
    expect(recorded.length).toBeGreaterThan(0);
    expect(await db.auditLog.count({ where: { action: "monitoring.alert" } })).toBeGreaterThan(0);
  });

  it("GET /api/admin/health devuelve estado, BD, colas, jobs y backup", async () => {
    await db.paymentProvider.create({
      data: { code: "MANUAL_TRANSFER", name: "Transferencia manual", type: "MANUAL", status: "OPERATIVO", sandboxMode: false, authorizedForRaffles: true },
    });
    await runJobByName("backup-daily");
    const admin = await createUser({ role: "SUPERADMIN", email: "admin@test.do" });
    const res = await health(makeRequest("/api/admin/health", { token: await loginToken(admin) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      database: string;
      queues: { notifications: { pending: number; failed: number } };
      jobs: Record<string, { status: string | null }>;
      lastBackupAt: string | null;
      lastBackupVerified: boolean;
    };
    expect(json.database).toBe("ok");
    expect(json.status).toBe("ok");
    expect(json.queues.notifications.pending).toBe(0);
    expect(json.jobs["backup-daily"].status).toBe("COMPLETED");
    expect(json.lastBackupAt).not.toBeNull();
    expect(json.lastBackupVerified).toBe(true);
    // Sin permiso de monitoreo → 403.
    const cliente = await createUser({ role: "CLIENTE", email: "c@test.do" });
    const denied = await health(makeRequest("/api/admin/health", { token: await loginToken(cliente) }));
    expect(denied.status).toBe(403);
  });

  it("GET /api/admin/notifications filtra por estado y exige permiso", async () => {
    await enqueueNotification({ event: "pago_confirmado", channel: "EMAIL", recipient: "a@test.do", data: {} });
    const failed = await enqueueNotification({ event: "pago_confirmado", channel: "WHATSAPP", recipient: "+18090000000", data: {} });
    await dispatchNotification(failed.id);
    const admin = await createUser({ role: "SUPERADMIN", email: "admin@test.do" });
    const token = await loginToken(admin);
    const res = await adminNotifications(makeRequest("/api/admin/notifications?status=FALLIDO", { token }));
    const json = (await res.json()) as { data: Array<{ status: string }>; total: number };
    expect(res.status).toBe(200);
    expect(json.total).toBe(1);
    expect(json.data[0].status).toBe("FALLIDO");
    const sys = await getSystemHealth();
    expect(sys.queues.notifications.failed).toBe(1);
    expect(sys.queues.notifications.pending).toBe(1);
  });
});
