// POST /api/admin/payment-providers/[id]/deactivate — desactiva un proveedor
// (vuelve a NO_OPERATIVO). No requiere gate.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { sanitizeProvider } from "@/lib/payments/registry";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "paymentProviders.manage");
    const provider = await db.paymentProvider.findUnique({ where: { id } });
    if (!provider) return NextResponse.json({ error: "Proveedor no existe" }, { status: 404 });
    const updated = await db.paymentProvider.update({
      where: { id },
      data: { status: "NO_OPERATIVO", verifiedAt: null },
    });
    await logAudit({
      actorId: user.id,
      action: "payments.provider.deactivate",
      entity: "PaymentProvider",
      entityId: id,
      before: { status: provider.status },
      after: { status: "NO_OPERATIVO" },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: sanitizeProvider(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}
