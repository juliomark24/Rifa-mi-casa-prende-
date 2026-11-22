// RBAC (P11 parcial, S2): acceso denegado por rol; auditor solo lectura;
// admin de rifas no aprueba retiros; afiliado no ve finanzas.
import { beforeEach, describe, expect, it } from "vitest";
import { GET as listProviders } from "../src/app/api/admin/payment-providers/route";
import { hasPermission } from "../src/lib/permissions";
import { cleanDb, createUser, loginToken, makeRequest, seedProviders } from "./helpers";

describe("RBAC matriz de permisos", () => {
  it("cliente y afiliado no tienen permisos de admin", () => {
    expect(hasPermission("CLIENTE", "raffles.view")).toBe(false);
    expect(hasPermission("CLIENTE", "audit.view")).toBe(false);
    expect(hasPermission("AFILIADO", "payments.view")).toBe(false);
    expect(hasPermission("AFILIADO", "raffles.create")).toBe(false);
  });

  it("auditor: solo lectura de todo, sin modificar", () => {
    expect(hasPermission("AUDITOR", "raffles.view")).toBe(true);
    expect(hasPermission("AUDITOR", "audit.view")).toBe(true);
    expect(hasPermission("AUDITOR", "payments.view")).toBe(true);
    expect(hasPermission("AUDITOR", "raffles.create")).toBe(false);
    expect(hasPermission("AUDITOR", "orders.confirm")).toBe(false);
    expect(hasPermission("AUDITOR", "withdrawals.approve")).toBe(false);
    expect(hasPermission("AUDITOR", "settings.edit")).toBe(false);
  });

  it("admin de rifas: rifas y sorteos sí, retiros y finanzas no", () => {
    expect(hasPermission("ADMIN_RIFAS", "raffles.create")).toBe(true);
    expect(hasPermission("ADMIN_RIFAS", "raffles.draw")).toBe(true);
    expect(hasPermission("ADMIN_RIFAS", "withdrawals.approve")).toBe(false);
    expect(hasPermission("ADMIN_RIFAS", "withdrawals.pay")).toBe(false);
    expect(hasPermission("ADMIN_RIFAS", "orders.confirm")).toBe(false);
    expect(hasPermission("ADMIN_RIFAS", "payments.verify")).toBe(false);
  });

  it("finanzas: pagos y retiros sí, crear rifas no", () => {
    expect(hasPermission("FINANZAS", "orders.confirm")).toBe(true);
    expect(hasPermission("FINANZAS", "withdrawals.approve")).toBe(true);
    expect(hasPermission("FINANZAS", "paymentProviders.manage")).toBe(true);
    expect(hasPermission("FINANZAS", "raffles.create")).toBe(false);
    expect(hasPermission("FINANZAS", "raffles.draw")).toBe(false);
  });

  it("superadmin lo tiene todo; marketing no toca finanzas ni rifas", () => {
    expect(hasPermission("SUPERADMIN", "recovery.approve")).toBe(true);
    expect(hasPermission("SUPERADMIN", "countries.activate")).toBe(true);
    expect(hasPermission("MARKETING", "affiliates.view")).toBe(true);
    expect(hasPermission("MARKETING", "orders.confirm")).toBe(false);
    expect(hasPermission("MARKETING", "raffles.create")).toBe(false);
  });
});

describe("RBAC en endpoints admin", () => {
  beforeEach(async () => {
    await cleanDb();
    await seedProviders();
  });

  it("cliente en endpoint admin → 403", async () => {
    const user = await createUser({ role: "CLIENTE" });
    const res = await listProviders(makeRequest("/api/admin/payment-providers", { token: await loginToken(user) }));
    expect(res.status).toBe(403);
  });

  it("afiliado no ve integraciones de pago (finanzas) → 403", async () => {
    const user = await createUser({ role: "AFILIADO" });
    const res = await listProviders(makeRequest("/api/admin/payment-providers", { token: await loginToken(user) }));
    expect(res.status).toBe(403);
  });

  it("auditor sí puede leer (solo lectura) → 200 con 4 proveedores", async () => {
    const user = await createUser({ role: "AUDITOR" });
    const res = await listProviders(makeRequest("/api/admin/payment-providers", { token: await loginToken(user) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(4);
  });

  it("sin sesión → 401", async () => {
    const res = await listProviders(makeRequest("/api/admin/payment-providers"));
    expect(res.status).toBe(401);
  });
});
