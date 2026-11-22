// PATCH / DELETE /api/admin/payment-methods/[id] — métodos de pago.
// S9-int: las rutas no existían aunque el contrato las define y el panel
// admin las usa (activar/desactivar y eliminar desde /admin/metodos-pago).
// PATCH solo toca etiqueta, detalles y habilitación del método (la
// configuración del proveedor — credenciales, sandbox, activación con
// gate — se gestiona en /api/admin/payment-providers). DELETE elimina el
// método y sus configuraciones por país (cascada del schema); el
// proveedor NO se elimina. Todo queda en auditoría.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse, notFound } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { parseBody, paymentMethodPatchSchema } from "@/lib/validate";
import { presentPaymentMethod } from "@/lib/payment-methods";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "paymentProviders.manage");
    const body = await parseBody(req, paymentMethodPatchSchema);
    const before = await db.paymentMethod.findUnique({ where: { id } });
    if (!before) throw notFound("Método de pago no existe");
    const updated = await db.paymentMethod.update({
      where: { id },
      data: {
        label: body.label,
        details: body.details === null ? "" : body.details,
        enabled: body.enabled,
      },
      include: {
        provider: { select: { code: true, name: true, status: true, sandboxMode: true } },
        configs: {
          include: { country: { select: { code: true, currencyCode: true } } },
          orderBy: { priority: "asc" },
        },
      },
    });
    await logAudit({
      actorId: user.id,
      action: "payments.method.update",
      entity: "PaymentMethod",
      entityId: id,
      before: { label: before.label, details: before.details, enabled: before.enabled },
      after: { label: updated.label, details: updated.details, enabled: updated.enabled },
    });
    return NextResponse.json({ data: presentPaymentMethod(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "paymentProviders.manage");
    const before = await db.paymentMethod.findUnique({ where: { id } });
    if (!before) throw notFound("Método de pago no existe");
    await db.paymentMethod.delete({ where: { id } });
    await logAudit({
      actorId: user.id,
      action: "payments.method.delete",
      entity: "PaymentMethod",
      entityId: id,
      before: { code: before.code, label: before.label },
      after: { deleted: true },
    });
    return NextResponse.json({ deleted: true, id });
  } catch (err) {
    return errorResponse(err);
  }
}
