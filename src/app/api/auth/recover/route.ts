// POST /api/auth/recover — público. Inicio de recuperación de cuenta admin.
// Genera una RecoveryRequest PENDIENTE (token hash, expira 1 h).
// Respuesta SIEMPRE genérica: nunca revela si la cuenta existe.
// NO salta 2FA: la solicitud debe aprobarla OTRO SUPERADMIN con 2FA y el
// reseteo exige además el código de un solo uso (ver recover/complete).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { isAdminRole } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashToken, randomToken } from "@/lib/totp";
import { parseBody, recoverSchema } from "@/lib/validate";

const GENERIC_MESSAGE =
  "Si la cuenta existe y es administrativa, se registró una solicitud de recuperación. Un superadministrador deberá aprobarla.";

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const body = await parseBody(req, recoverSchema);
    checkRateLimit(`recover:${ip ?? "unknown"}:${body.email}`, { limit: 3, windowMs: 60 * 60 * 1000 });

    const user = await db.user.findUnique({ where: { email: body.email } });
    if (user && isAdminRole(user.role)) {
      // Expira solicitudes pendientes anteriores del mismo usuario.
      await db.recoveryRequest.updateMany({
        where: { userId: user.id, status: "PENDIENTE" },
        data: { status: "EXPIRADO" },
      });
      await db.recoveryRequest.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(randomToken()),
          status: "PENDIENTE",
          reason: "Recuperación de cuenta admin / 2FA",
          requestedIp: ip,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      await logAudit({
        actorId: user.id,
        action: "auth.recover.requested",
        entity: "RecoveryRequest",
        entityId: user.id,
        ipAddress: ip,
      });
    }
    // Respuesta genérica en todos los casos (no filtrar existencia).
    return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
  } catch (err) {
    return errorResponse(err);
  }
}
