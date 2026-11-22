// Lógica compartida de la prueba de sandbox de un proveedor
// (usada por /api/admin/payment-providers/[id]/test-sandbox y por
// /api/admin/integrations/[provider]/test-sandbox).
import { NextResponse } from "next/server";
import { logAudit } from "../audit";
import { db } from "../db";
import { getAdapter } from "./registry";

export async function runSandboxTest(
  providerId: string,
  actorId: string,
  ip: string | null,
): Promise<NextResponse> {
  const provider = await db.paymentProvider.findUnique({ where: { id: providerId } });
  if (!provider) return NextResponse.json({ error: "Proveedor no existe" }, { status: 404 });

  const adapter = getAdapter(provider.code);
  const result = await adapter.testConnection();
  await db.paymentProvider.update({
    where: { id: providerId },
    data: { lastSandboxTestAt: result.checkedAt, lastSandboxTestPassed: result.ok },
  });
  await logAudit({
    actorId,
    action: "payments.provider.test-sandbox",
    entity: "PaymentProvider",
    entityId: providerId,
    after: { ok: result.ok, message: result.message },
    ipAddress: ip,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.message, code: "NOT_CONFIGURED" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, message: result.message });
}
