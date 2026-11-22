// Sesiones revocables: logout revoca; sesión revocada o expirada no sirve.
import { beforeEach, describe, expect, it } from "vitest";
import { POST as logout } from "../src/app/api/auth/logout/route";
import { GET as me } from "../src/app/api/auth/me/route";
import { revokeSession } from "../src/lib/auth";
import { db } from "../src/lib/db";
import { cleanDb, createUser, loginToken, makeRequest } from "./helpers";

describe("sesiones", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("logout revoca la sesión: /me después → 401", async () => {
    const user = await createUser({});
    const token = await loginToken(user);
    expect((await me(makeRequest("/api/auth/me", { token }))).status).toBe(200);
    const logoutRes = await logout(makeRequest("/api/auth/logout", { method: "POST", token }));
    expect(logoutRes.status).toBe(200);
    const session = await db.session.findFirst({ where: { userId: user.id } });
    expect(session?.revokedAt).not.toBeNull();
    expect((await me(makeRequest("/api/auth/me", { token }))).status).toBe(401);
  });

  it("revocar desde el servidor invalida el JWT aunque no haya expirado", async () => {
    const user = await createUser({});
    const token = await loginToken(user);
    const session = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    await revokeSession(session.id);
    expect((await me(makeRequest("/api/auth/me", { token }))).status).toBe(401);
  });

  it("sesión expirada no sirve", async () => {
    const user = await createUser({});
    const token = await loginToken(user);
    await db.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await me(makeRequest("/api/auth/me", { token }))).status).toBe(401);
  });

  it("un JWT con jti desconocido no sirve", async () => {
    const user = await createUser({});
    const token = await loginToken(user);
    await db.session.deleteMany({ where: { userId: user.id } });
    expect((await me(makeRequest("/api/auth/me", { token }))).status).toBe(401);
  });
});
