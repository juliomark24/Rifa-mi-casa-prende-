// POST /api/auth/recover/complete — público. Completa la recuperación con
// el código de un solo uso (15 min) entregado tras la aprobación.
// Efectos: resetea la contraseña, revoca TODAS las sesiones, invalida el
// secreto TOTP anterior y obliga a re-enrolar 2FA antes de cualquier
// acción admin. Todo queda en audit log.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { hashPassword, revokeAllSessions } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse, unauthorized } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashToken } from "@/lib/totp";
import { parseBody, recoverCompleteSchema } from "@/lib/validate";
import crypto from "node:crypto";

const MAX_CODE_ATTEMPTS = 5;

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const body = await parseBody(req, recoverCompleteSchema);
    checkRateLimit(`recover-complete:${ip ?? "unknown"}:${body.email}`, {
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });

    const user = await db.user.findUnique({ where: { email: body.email } });
    if (!user) throw unauthorized("Código inválido o expirado");

    const request = await db.recoveryRequest.findFirst({
      where: {
        userId: user.id,
        status: "APROBADO",
        resetCodeExpiresAt: { gt: new Date() },
      },
      orderBy: { approvedAt: "desc" },
    });
    if (!request || !request.resetCodeHash) {
      throw unauthorized("Código inválido o expirado");
    }
    if (request.resetCodeAttempts >= MAX_CODE_ATTEMPTS) {
      throw unauthorized("Demasiados intentos con el código. Solicita una nueva recuperación.");
    }

    const provided = Buffer.from(hashToken(body.code));
    const expected = Buffer.from(request.resetCodeHash);
    const matches =
      provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!matches) {
      await db.recoveryRequest.update({
        where: { id: request.id },
        data: { resetCodeAttempts: { increment: 1 } },
      });
      throw unauthorized("Código inválido o expirado");
    }

    await db.$transaction([
      db.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(body.newPassword), mustReenroll2fa: true },
      }),
      // Invalida el secreto TOTP anterior.
      db.twoFactor.deleteMany({ where: { userId: user.id } }),
      db.recoveryRequest.update({
        where: { id: request.id },
        data: { status: "COMPLETADO", completedAt: new Date(), resetCodeHash: null },
      }),
    ]);
    // Revoca TODAS las sesiones (incluida cualquier sesión activa del atacante).
    await revokeAllSessions(user.id);
    await logAudit({
      actorId: user.id,
      action: "auth.recover.completed",
      entity: "RecoveryRequest",
      entityId: request.id,
      after: { mustReenroll2fa: true, sessionsRevoked: true, totpInvalidated: true },
      ipAddress: ip,
    });
    return NextResponse.json({
      ok: true,
      message:
        "Contraseña restablecida. Todas las sesiones fueron revocadas y el 2FA anterior quedó invalidado. Debes configurar 2FA de nuevo antes de realizar acciones administrativas.",
    });
  } catch (err) {
    return errorResponse(err);
  }
}
