// Auth: registro/login, rol nunca del cliente, hash bcrypt 12.
import { beforeEach, describe, expect, it } from "vitest";
import { POST as register } from "../src/app/api/auth/register/route";
import { POST as registerAfiliado } from "../src/app/api/auth/register-afiliado/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { GET as me } from "../src/app/api/auth/me/route";
import { db } from "../src/lib/db";
import { cleanDb, createUser, getCookieToken, makeRequest } from "./helpers";

describe("auth", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("register crea CLIENTE y nunca expone passwordHash", async () => {
    const res = await register(
      makeRequest("/api/auth/register", {
        method: "POST",
        body: { name: "Julio", email: "julio@test.do", password: "Password123!" },
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { user: Record<string, unknown> };
    expect(json.user.role).toBe("CLIENTE");
    expect(json.user).not.toHaveProperty("passwordHash");
    const row = await db.user.findUnique({ where: { email: "julio@test.do" } });
    expect(row?.passwordHash).toMatch(/^\$2[ab]\$12\$/); // bcrypt 12 rounds
  });

  it("register ignora el rol enviado por el cliente (nunca SUPERADMIN)", async () => {
    const res = await register(
      makeRequest("/api/auth/register", {
        method: "POST",
        body: { name: "Atacante", email: "evil@test.do", password: "Password123!", role: "SUPERADMIN" },
      }),
    );
    expect(res.status).toBe(201);
    const row = await db.user.findUnique({ where: { email: "evil@test.do" } });
    expect(row?.role).toBe("CLIENTE");
  });

  it("register rechaza email duplicado (409) y datos inválidos (400)", async () => {
    await createUser({ email: "dup@test.do" });
    const dup = await register(
      makeRequest("/api/auth/register", {
        method: "POST",
        body: { name: "Dup", email: "dup@test.do", password: "Password123!" },
      }),
    );
    expect(dup.status).toBe(409);
    const bad = await register(
      makeRequest("/api/auth/register", {
        method: "POST",
        body: { name: "Xx", email: "no-es-email", password: "short" },
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("register-afiliado crea AFILIADO con referralCode único", async () => {
    const res = await registerAfiliado(
      makeRequest("/api/auth/register-afiliado", {
        method: "POST",
        body: { name: "Afiliado", email: "af@test.do", password: "Password123!" },
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { user: { role: string; referralCode: string } };
    expect(json.user.role).toBe("AFILIADO");
    expect(json.user.referralCode).toMatch(/^PRENDE[0-9A-F]{6}$/);
  });

  it("login correcto crea sesión (cookie httpOnly) y /me la reconoce", async () => {
    await createUser({ email: "julio@test.do", password: "Password123!" });
    const res = await login(
      makeRequest("/api/auth/login", {
        method: "POST",
        body: { email: "julio@test.do", password: "Password123!" },
      }),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("pr_session=");
    expect(setCookie).toContain("HttpOnly");
    const token = getCookieToken(res);
    expect(token).toBeTruthy();
    const sessions = await db.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).toBeNull();

    const meRes = await me(makeRequest("/api/auth/me", { token: token! }));
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as { user: { email: string; role: string } };
    expect(meJson.user.email).toBe("julio@test.do");
    expect(meJson.user.role).toBe("CLIENTE");
  });

  it("login con contraseña incorrecta → 401 y sin sesión", async () => {
    await createUser({ email: "julio@test.do", password: "Password123!" });
    const res = await login(
      makeRequest("/api/auth/login", {
        method: "POST",
        body: { email: "julio@test.do", password: "WrongPass123!" },
      }),
    );
    expect(res.status).toBe(401);
    expect(await db.session.count()).toBe(0);
  });

  it("login bloquea la cuenta tras 5 intentos fallidos", async () => {
    await createUser({ email: "lock@test.do", password: "Password123!" });
    for (let i = 0; i < 5; i++) {
      await login(
        makeRequest("/api/auth/login", {
          method: "POST",
          body: { email: "lock@test.do", password: "WrongPass123!" },
        }),
      );
    }
    const row = await db.user.findUnique({ where: { email: "lock@test.do" } });
    expect(row?.lockedUntil).not.toBeNull();
    const blocked = await login(
      makeRequest("/api/auth/login", {
        method: "POST",
        body: { email: "lock@test.do", password: "Password123!" },
      }),
    );
    expect(blocked.status).toBe(401);
  });

  it("/me sin sesión → 401", async () => {
    const res = await me(makeRequest("/api/auth/me"));
    expect(res.status).toBe(401);
  });
});
