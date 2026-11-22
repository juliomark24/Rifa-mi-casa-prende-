// 2FA: setup/verify/login con código, backup codes, disable con 2FA.
// También pruebas unitarias del TOTP (totp.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as login2fa } from "../src/app/api/auth/login-2fa/route";
import { POST as disable2fa } from "../src/app/api/auth/2fa/disable/route";
import { POST as setup2fa } from "../src/app/api/auth/2fa/setup/route";
import { POST as verify2fa } from "../src/app/api/auth/2fa/verify/route";
import { db } from "../src/lib/db";
import {
  consumeBackupCode,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpCode,
  generateTotpSecret,
  verifyTotp,
} from "../src/lib/totp";
import { cleanDb, createUser, getCookieToken, loginToken, makeRequest } from "./helpers";

describe("totp unitario", () => {
  it("el código generado se verifica (y uno incorrecto no)", () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, "000000")).toBe(false);
    expect(verifyTotp(secret, "abc")).toBe(false);
  });

  it("el secreto cifrado se descifra igual (roundtrip)", () => {
    const secret = generateTotpSecret();
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("backup codes: cada uno sirve una sola vez", async () => {
    const { codes, hashes } = generateBackupCodes(2);
    expect(codes).toHaveLength(2);
    const remaining = await consumeBackupCode(hashes, codes[0]);
    expect(remaining).not.toBeNull();
    expect(remaining).toHaveLength(1);
    // El mismo código ya no sirve.
    expect(await consumeBackupCode(remaining!, codes[0])).toBeNull();
    // El segundo sigue sirviendo.
    expect(await consumeBackupCode(remaining!, codes[1])).toHaveLength(0);
  });
});

describe("2FA por API", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  async function enable2faFor(email: string) {
    const admin = await createUser({ role: "SUPERADMIN", email });
    const token = await loginToken(admin);
    const setupRes = await setup2fa(makeRequest("/api/auth/2fa/setup", { method: "POST", token }));
    expect(setupRes.status).toBe(200);
    const setup = (await setupRes.json()) as { otpauthUrl: string; backupCodes: string[] };
    expect(setup.backupCodes).toHaveLength(8);
    const secret = new URL(setup.otpauthUrl).searchParams.get("secret")!;
    const code = generateTotpCode(secret);
    const verifyRes = await verify2fa(
      makeRequest("/api/auth/2fa/verify", { method: "POST", body: { code }, token }),
    );
    expect(verifyRes.status).toBe(200);
    return { admin, setup, secret };
  }

  it("setup devuelve otpauthUrl + 8 backup codes; verify activa el 2FA", async () => {
    const { admin } = await enable2faFor("admin2fa@test.do");
    const tf = await db.twoFactor.findUnique({ where: { userId: admin.id } });
    expect(tf?.enabled).toBe(true);
    expect(tf?.secretEncrypted).not.toContain("otpauth");
  });

  it("setup para CLIENTE → 403 (2FA solo admin)", async () => {
    const user = await createUser({ role: "CLIENTE" });
    const res = await setup2fa(
      makeRequest("/api/auth/2fa/setup", { method: "POST", token: await loginToken(user) }),
    );
    expect(res.status).toBe(403);
  });

  it("login con 2FA activo → 202 requires2FA; login-2fa con código → 200 + cookie", async () => {
    const { secret } = await enable2faFor("adminlogin@test.do");
    const loginRes = await login(
      makeRequest("/api/auth/login", {
        method: "POST",
        body: { email: "adminlogin@test.do", password: "Password123!" },
      }),
    );
    expect(loginRes.status).toBe(202);
    expect((await loginRes.json()) as { requires2FA: boolean }).toMatchObject({ requires2FA: true });
    expect(loginRes.headers.get("set-cookie")).toBeNull();
    // El 202 NO crea sesión nueva (la única sesión es la del setup).
    expect(await db.session.count()).toBe(1);

    const code = generateTotpCode(secret);
    const res2 = await login2fa(
      makeRequest("/api/auth/login-2fa", {
        method: "POST",
        body: { email: "adminlogin@test.do", code },
      }),
    );
    expect(res2.status).toBe(200);
    expect(getCookieToken(res2)).toBeTruthy();
    expect(await db.session.count()).toBe(2); // setup + login-2fa
  });

  it("login-2fa con código incorrecto → 401", async () => {
    await enable2faFor("adminbad@test.do");
    const res = await login2fa(
      makeRequest("/api/auth/login-2fa", {
        method: "POST",
        body: { email: "adminbad@test.do", code: "000000" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("login-2fa con código de respaldo funciona una sola vez", async () => {
    const { setup } = await enable2faFor("adminbk@test.do");
    const backup = setup.backupCodes[0];
    const res = await login2fa(
      makeRequest("/api/auth/login-2fa", {
        method: "POST",
        body: { email: "adminbk@test.do", code: backup },
      }),
    );
    expect(res.status).toBe(200);
    const res2 = await login2fa(
      makeRequest("/api/auth/login-2fa", {
        method: "POST",
        body: { email: "adminbk@test.do", code: backup },
      }),
    );
    expect(res2.status).toBe(401);
  });

  it("disable exige contraseña + código 2FA vigente; después el login ya no pide 2FA", async () => {
    const { secret, admin } = await enable2faFor("admindis@test.do");
    const token = await loginToken(admin);
    const wrong = await disable2fa(
      makeRequest("/api/auth/2fa/disable", {
        method: "POST",
        body: { password: "Password123!", code: "000000" },
        token,
      }),
    );
    expect(wrong.status).toBe(400);
    const ok = await disable2fa(
      makeRequest("/api/auth/2fa/disable", {
        method: "POST",
        body: { password: "Password123!", code: generateTotpCode(secret) },
        token,
      }),
    );
    expect(ok.status).toBe(200);
    expect(await db.twoFactor.findUnique({ where: { userId: admin.id } })).toBeNull();
    const loginRes = await login(
      makeRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admindis@test.do", password: "Password123!" },
      }),
    );
    expect(loginRes.status).toBe(200);
  });
});
