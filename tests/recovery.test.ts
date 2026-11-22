// Recuperación admin/2FA (regla 5): flujo completo + intentos de salto.
// Flujo: recover (genérico) → approve por OTRO SUPERADMIN con 2FA →
// complete con código de un solo uso → resetea contraseña, revoca TODAS
// las sesiones, invalida TOTP y obliga re-enrolar 2FA.
import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "../src/app/api/auth/login/route";
import { GET as me } from "../src/app/api/auth/me/route";
import { GET as listProviders } from "../src/app/api/admin/payment-providers/route";
import { GET as listRecovery } from "../src/app/api/admin/recovery-requests/route";
import { POST as approve } from "../src/app/api/admin/recovery-requests/[id]/approve/route";
import { POST as recover } from "../src/app/api/auth/recover/route";
import { POST as complete } from "../src/app/api/auth/recover/complete/route";
import { db } from "../src/lib/db";
import { encryptSecret, generateTotpSecret } from "../src/lib/totp";
import { cleanDb, createUser, loginToken, makeRequest, seedProviders } from "./helpers";

describe("recuperación admin/2FA", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedProviders();
  });

  async function setupActors() {
    const victim = await createUser({ role: "SUPERADMIN", email: "victim@test.do" });
    const approver = await createUser({ role: "SUPERADMIN", email: "approver@test.do" });
    // El aprobador tiene 2FA activo.
    await db.twoFactor.create({
      data: {
        userId: approver.id,
        secretEncrypted: encryptSecret(generateTotpSecret()),
        enabled: true,
        backupCodesHash: [],
      },
    });
    // La víctima tiene 2FA activo (se perderá con la recuperación) y sesión.
    await db.twoFactor.create({
      data: {
        userId: victim.id,
        secretEncrypted: encryptSecret(generateTotpSecret()),
        enabled: true,
        backupCodesHash: [],
      },
    });
    const victimToken = await loginToken(victim);
    return { victim, approver, victimToken };
  }

  async function requestAndApprove(victimEmail: string, approverToken: string) {
    const rec = await recover(
      makeRequest("/api/auth/recover", { method: "POST", body: { email: victimEmail } }),
    );
    expect(rec.status).toBe(200);
    const reqRow = await db.recoveryRequest.findFirstOrThrow({ where: { status: "PENDIENTE" } });
    const appr = await approve(
      makeRequest(`/api/admin/recovery-requests/${reqRow.id}/approve`, { method: "POST", token: approverToken }),
      { params: Promise.resolve({ id: reqRow.id }) },
    );
    return { reqRow, appr };
  }

  it("recover responde genérico incluso para email inexistente", async () => {
    const res = await recover(
      makeRequest("/api/auth/recover", { method: "POST", body: { email: "nadie@test.do" } }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { message: string };
    expect(json.message).toMatch(/solicitud de recuperación/);
    expect(await db.recoveryRequest.count()).toBe(0);
  });

  it("flujo completo: recover → approve (otro superadmin con 2FA) → complete", async () => {
    const { victim, approver, victimToken } = await setupActors();
    const approverToken = await loginToken(approver);
    const { reqRow, appr } = await requestAndApprove("victim@test.do", approverToken);
    expect(appr.status).toBe(200);
    const apprJson = (await appr.json()) as { devCode: string };
    expect(apprJson.devCode).toMatch(/^\d{6}$/);

    const done = await complete(
      makeRequest("/api/auth/recover/complete", {
        method: "POST",
        body: { email: "victim@test.do", code: apprJson.devCode, newPassword: "NuevaPass123!" },
      }),
    );
    expect(done.status).toBe(200);

    // Contraseña cambiada.
    const loginOld = await login(
      makeRequest("/api/auth/login", { method: "POST", body: { email: "victim@test.do", password: "Password123!" } }),
    );
    expect(loginOld.status).toBe(401);

    // TODAS las sesiones revocadas (incluida la anterior a la recuperación).
    // Se comprueba ANTES de volver a loguearse (el login nuevo crea sesión).
    expect((await db.session.findMany({ where: { userId: victim.id, revokedAt: null } })).length).toBe(0);
    expect((await me(makeRequest("/api/auth/me", { token: victimToken })))).toHaveProperty("status", 401);

    const loginNew = await login(
      makeRequest("/api/auth/login", { method: "POST", body: { email: "victim@test.do", password: "NuevaPass123!" } }),
    );
    expect(loginNew.status).toBe(200);

    // TOTP anterior invalidado + obliga re-enrolar 2FA.
    expect(await db.twoFactor.findUnique({ where: { userId: victim.id } })).toBeNull();
    const updated = await db.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(updated.mustReenroll2fa).toBe(true);
    const reqAfter = await db.recoveryRequest.findUniqueOrThrow({ where: { id: reqRow.id } });
    expect(reqAfter.status).toBe("COMPLETADO");

    // La sesión nueva (tras login) no puede hacer acciones admin hasta re-enrolar 2FA.
    const newToken = await loginToken(updated);
    const adminAttempt = await listProviders(
      makeRequest("/api/admin/payment-providers", { token: newToken }),
    );
    expect(adminAttempt.status).toBe(403);
    expect(((await adminAttempt.json()) as { code: string }).code).toBe("REQUIRES_2FA_SETUP");
  });

  it("intento de salto 1: completar sin aprobación → 401", async () => {
    await setupActors();
    await recover(makeRequest("/api/auth/recover", { method: "POST", body: { email: "victim@test.do" } }));
    const res = await complete(
      makeRequest("/api/auth/recover/complete", {
        method: "POST",
        body: { email: "victim@test.do", code: "123456", newPassword: "NuevaPass123!" },
      }),
    );
    expect(res.status).toBe(401);
    // La contraseña no cambió: el login con la vieja sigue aceptando
    // la contraseña (202 porque la víctima aún tiene 2FA activo).
    const loginRes = await login(
      makeRequest("/api/auth/login", { method: "POST", body: { email: "victim@test.do", password: "Password123!" } }),
    );
    expect(loginRes.status).toBe(202);
  });

  it("intento de salto 2: auto-aprobación denegada (403)", async () => {
    const { victim } = await setupActors();
    await recover(makeRequest("/api/auth/recover", { method: "POST", body: { email: "victim@test.do" } }));
    const reqRow = await db.recoveryRequest.findFirstOrThrow({ where: { status: "PENDIENTE" } });
    const selfToken = await loginToken(victim);
    const res = await approve(
      makeRequest(`/api/admin/recovery-requests/${reqRow.id}/approve`, { method: "POST", token: selfToken }),
      { params: Promise.resolve({ id: reqRow.id }) },
    );
    expect(res.status).toBe(403);
    expect((await db.recoveryRequest.findUniqueOrThrow({ where: { id: reqRow.id } })).status).toBe("PENDIENTE");
  });

  it("intento de salto 3: aprobador sin 2FA → 403", async () => {
    const { victim } = await setupActors();
    const no2fa = await createUser({ role: "SUPERADMIN", email: "no2fa@test.do" });
    await recover(makeRequest("/api/auth/recover", { method: "POST", body: { email: "victim@test.do" } }));
    const reqRow = await db.recoveryRequest.findFirstOrThrow({ where: { status: "PENDIENTE" } });
    const res = await approve(
      makeRequest(`/api/admin/recovery-requests/${reqRow.id}/approve`, {
        method: "POST",
        token: await loginToken(no2fa),
      }),
      { params: Promise.resolve({ id: reqRow.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("intento de salto 4: código incorrecto repetido → 401 y no resetea", async () => {
    const { approver } = await setupActors();
    const { appr } = await requestAndApprove("victim@test.do", await loginToken(approver));
    const { devCode } = (await appr.json()) as { devCode: string };
    const wrong = await complete(
      makeRequest("/api/auth/recover/complete", {
        method: "POST",
        body: { email: "victim@test.do", code: "000000", newPassword: "NuevaPass123!" },
      }),
    );
    expect(wrong.status).toBe(401);
    // El código correcto sigue sirviendo después de un fallo.
    const ok = await complete(
      makeRequest("/api/auth/recover/complete", {
        method: "POST",
        body: { email: "victim@test.do", code: devCode, newPassword: "NuevaPass123!" },
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("intento de salto 5: el código no se puede reutilizar", async () => {
    const { approver } = await setupActors();
    const { appr } = await requestAndApprove("victim@test.do", await loginToken(approver));
    const { devCode } = (await appr.json()) as { devCode: string };
    const body = { email: "victim@test.do", code: devCode, newPassword: "NuevaPass123!" };
    expect((await complete(makeRequest("/api/auth/recover/complete", { method: "POST", body })))).toHaveProperty("status", 200);
    const reuse = await complete(
      makeRequest("/api/auth/recover/complete", { method: "POST", body }),
    );
    expect(reuse.status).toBe(401);
  });

  it("listado de solicitudes solo para quien puede aprobar", async () => {
    const { approver } = await setupActors();
    const cliente = await createUser({ role: "CLIENTE" });
    const denied = await listRecovery(makeRequest("/api/admin/recovery-requests", { token: await loginToken(cliente) }));
    expect(denied.status).toBe(403);
    const allowed = await listRecovery(makeRequest("/api/admin/recovery-requests", { token: await loginToken(approver) }));
    expect(allowed.status).toBe(200);
  });
});
