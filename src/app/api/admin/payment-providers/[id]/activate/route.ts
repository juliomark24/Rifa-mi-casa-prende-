// POST /api/admin/payment-providers/[id]/activate — activa un proveedor
// SOLO si pasa el gate (regla 6): credenciales (referencia segura), prueba
// de sandbox superada y autorización para rifas. La transferencia manual
// queda exenta de la prueba de sandbox (no tiene integración externa).
// Si el gate no pasa → 409 con los motivos.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { conflict, errorResponse } from "@/lib/errors";
import { providerGateCheck, sanitizeProvider } from "@/lib/payments/registry";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "paymentProviders.manage");
    const provider = await db.paymentProvider.findUnique({ where: { id } });
    if (!provider) return NextResponse.json({ error: "Proveedor no existe" }, { status: 404 });
    if (provider.status === "OPERATIVO") {
      return NextResponse.json({ data: sanitizeProvider(provider), message: "El proveedor ya está operativo" });
    }
    const gate = providerGateCheck(provider);
    if (!gate.ok) {
      throw conflict(`No se puede activar ${provider.name}: ${gate.reasons.join("; ")}`);
    }
    const updated = await db.paymentProvider.update({
      where: { id },
      data: { status: "OPERATIVO", verifiedAt: new Date() },
    });
    await db.configHistory.create({
      data: {
        entity: "PaymentProvider",
        entityId: id,
        changedById: user.id,
        before: { status: provider.status } as object,
        after: { status: "OPERATIVO" } as object,
        reason: "Activación tras gate (regla 6)",
      },
    });
    await logAudit({
      actorId: user.id,
      action: "payments.provider.activate",
      entity: "PaymentProvider",
      entityId: id,
      before: { status: provider.status },
      after: { status: "OPERATIVO" },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: sanitizeProvider(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}
