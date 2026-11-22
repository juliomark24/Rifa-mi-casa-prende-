// POST /api/admin/recovery-requests/[id]/approve — aprobación por OTRO
// SUPERADMIN con 2FA activo. Nunca auto-aprobación.
// Genera el código de un solo uso (15 min) que se entrega por el canal
// registrado del usuario (email). Todo queda en audit log.
//
// NOTA DE ENTORNO: en producción el código sale SOLO por el canal registrado
// (motor de notificaciones, S8). En tests (NODE_ENV=test) la respuesta
// incluye `devCode` para poder probar el flujo completo sin correo.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requireRole, userHas2faEnabled } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse, forbidden } from "@/lib/errors";
import { generateNumericCode, hashToken } from "@/lib/totp";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user: approver } = await requireRole(req, ["SUPERADMIN"]);
    if (!(await userHas2faEnabled(approver.id))) {
      throw forbidden("Para aprobar recuperaciones necesitas tener 2FA activo");
    }
    const request = await db.recoveryRequest.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, role: true } } },
    });
    if (!request) return NextResponse.json({ error: "Solicitud no existe" }, { status: 404 });
    if (request.status !== "PENDIENTE") {
      throw badRequest(`La solicitud ya está en estado ${request.status}`);
    }
    if (request.expiresAt < new Date()) {
      await db.recoveryRequest.update({ where: { id }, data: { status: "EXPIRADO" } });
      throw badRequest("La solicitud expiró");
    }
    if (request.userId === approver.id) {
      // Nunca auto-aprobación (regla 5).
      throw forbidden("No puedes aprobar tu propia solicitud de recuperación");
    }

    const code = generateNumericCode();
    await db.recoveryRequest.update({
      where: { id },
      data: {
        status: "APROBADO",
        approvedById: approver.id,
        approvedAt: new Date(),
        resetCodeHash: hashToken(code),
        resetCodeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        resetCodeAttempts: 0,
      },
    });
    await logAudit({
      actorId: approver.id,
      action: "auth.recover.approved",
      entity: "RecoveryRequest",
      entityId: id,
      after: { approvedFor: request.user.email, codeDeliveredVia: "registered-channel" },
      ipAddress: getClientIp(req),
    });
    const response: Record<string, unknown> = {
      ok: true,
      message: "Solicitud aprobada. El código de un solo uso (15 min) se envió por el canal registrado del usuario.",
    };
    if (process.env.NODE_ENV === "test") response.devCode = code;
    return NextResponse.json(response);
  } catch (err) {
    return errorResponse(err);
  }
}
