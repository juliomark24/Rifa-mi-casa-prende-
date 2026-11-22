// Registro de adaptadores de pago (aclaración 17:39): 4 preintegrados,
// solo manual operativo; resto 503 NOT_CONFIGURED; gate de activación.
import { beforeEach, describe, expect, it } from "vitest";
import { POST as activate } from "../src/app/api/admin/payment-providers/[id]/activate/route";
import { GET as listProviders } from "../src/app/api/admin/payment-providers/route";
import { POST as testSandbox } from "../src/app/api/admin/payment-providers/[id]/test-sandbox/route";
import { ApiError } from "../src/lib/errors";
import {
  ADAPTER_DEFAULT_STATUS,
  AzulAdapter,
  CardNetAdapter,
  ManualTransferAdapter,
  PayPalAdapter,
  getAdapter,
  listAdapters,
  providerGateCheck,
} from "../src/lib/payments/registry";
import { cleanDb, createUser, loginToken, makeRequest, seedProviders } from "./helpers";

describe("registro de adaptadores", () => {
  it("4 adaptadores preintegrados; solo manual operativo por defecto", () => {
    expect(listAdapters().map((a) => a.code).sort()).toEqual([
      "AZUL",
      "CARDNET",
      "MANUAL_TRANSFER",
      "PAYPAL",
    ]);
    expect(ADAPTER_DEFAULT_STATUS.MANUAL_TRANSFER).toBe("OPERATIVO");
    expect(ADAPTER_DEFAULT_STATUS.AZUL).toBe("NO_OPERATIVO");
    expect(ADAPTER_DEFAULT_STATUS.CARDNET).toBe("NO_OPERATIVO");
    expect(ADAPTER_DEFAULT_STATUS.PAYPAL).toBe("NO_OPERATIVO");
    expect(getAdapter("AZUL")).toBe(AzulAdapter);
    expect(() => getAdapter("STRIPE")).toThrow();
  });

  it("manual crea cobro con instrucciones y pasa el sandbox", async () => {
    const charge = await ManualTransferAdapter.createCharge({
      orderId: "o1",
      orderCode: "ORD-1",
      amount: 1000,
      currency: "DOP",
      buyerEmail: "c@test.do",
      buyerName: "Cliente",
    });
    expect(charge.status).toBe("PENDING_MANUAL_VERIFICATION");
    expect(charge.instructions).toContain("ORD-1");
    const test = await ManualTransferAdapter.testConnection();
    expect(test.ok).toBe(true);
  });

  it("Azul, CardNet y PayPal responden 503 NOT_CONFIGURED (regla 6)", async () => {
    for (const adapter of [AzulAdapter, CardNetAdapter, PayPalAdapter]) {
      await expect(
        adapter.createCharge({
          orderId: "o1",
          orderCode: "ORD-1",
          amount: 1000,
          currency: "DOP",
          buyerEmail: "c@test.do",
          buyerName: "Cliente",
        }),
      ).rejects.toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
      const test = await adapter.testConnection();
      expect(test.ok).toBe(false);
    }
    try {
      await PayPalAdapter.createCharge({
        orderId: "o1",
        orderCode: "ORD-1",
        amount: 1000,
        currency: "DOP",
        buyerEmail: "c@test.do",
        buyerName: "Cliente",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
  });
});

describe("gate de activación + endpoints admin", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("gate: manual pasa; Azul sin credenciales ni sandbox ni autorización no pasa", async () => {
    const { manual, azul } = await seedProviders();
    expect(providerGateCheck(manual).ok).toBe(true);
    const gate = providerGateCheck(azul);
    expect(gate.ok).toBe(false);
    expect(gate.reasons.length).toBe(3);
  });

  it("activar Azul sin gate → 409; con gate completo → 200", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const { azul } = await seedProviders();
    const denied = await activate(
      makeRequest(`/api/admin/payment-providers/${azul.id}/activate`, { method: "POST", token }),
      { params: Promise.resolve({ id: azul.id }) },
    );
    expect(denied.status).toBe(409);
    // Completa el gate: credenciales + sandbox superado + autorización.
    const { db } = await import("../src/lib/db");
    await db.paymentProvider.update({
      where: { id: azul.id },
      data: { credentialsRef: "env:AZUL_API_KEY", lastSandboxTestPassed: true, authorizedForRaffles: true },
    });
    const ok = await activate(
      makeRequest(`/api/admin/payment-providers/${azul.id}/activate`, { method: "POST", token }),
      { params: Promise.resolve({ id: azul.id }) },
    );
    expect(ok.status).toBe(200);
  });

  it("test-sandbox: manual 200, Azul 503 NOT_CONFIGURED", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    const { manual, azul } = await seedProviders();
    const ok = await testSandbox(
      makeRequest(`/api/admin/payment-providers/${manual.id}/test-sandbox`, { method: "POST", token }),
      { params: Promise.resolve({ id: manual.id }) },
    );
    expect(ok.status).toBe(200);
    const fail = await testSandbox(
      makeRequest(`/api/admin/payment-providers/${azul.id}/test-sandbox`, { method: "POST", token }),
      { params: Promise.resolve({ id: azul.id }) },
    );
    expect(fail.status).toBe(503);
    expect(((await fail.json()) as { code: string }).code).toBe("NOT_CONFIGURED");
  });

  it("listado no expone credenciales y muestra 4 proveedores", async () => {
    const admin = await createUser({ role: "SUPERADMIN" });
    const token = await loginToken(admin);
    await seedProviders();
    const res = await listProviders(makeRequest("/api/admin/payment-providers", { token }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(json.data).toHaveLength(4);
    expect(JSON.stringify(json)).not.toContain("credentialsEncrypted");
    const manual = json.data.find((p) => p.code === "MANUAL_TRANSFER");
    expect(manual?.status).toBe("OPERATIVO");
  });
});
