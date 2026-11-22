// PATCH /api/admin/raffles/[id] — edita una rifa.
// Cambios sensibles con ventas hechas (precio, total de boletos, premio)
// exigen doble aprobación (§2.20: approvedById de un segundo
// superadministrador) + registro en ChangeLog/AuditLog + aviso a
// compradores. Cambiar la fecha de sorteo exige motivo + registro + aviso
// (§2.7). Una rifa en estado congelado (CERRADA en adelante) no se edita.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { applyRafflePatch } from "@/lib/raffles";
import { parseBody, rafflePatchSchema } from "@/lib/validate";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "raffles.edit");
    const body = await parseBody(req, rafflePatchSchema);
    const updated = await applyRafflePatch({
      raffleId: id,
      changes: body,
      actorId: user.id,
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
