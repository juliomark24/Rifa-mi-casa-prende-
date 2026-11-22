// POST /api/auth/2fa/verify — ADMIN*. Activa el 2FA con un código vigente.
// Si el usuario venía de una recuperación (mustReenroll2fa), lo libera.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse, forbidden } from "@/lib/errors";
import { isAdminRole } from "@/lib/permissions";
import { decryptSecret, verifyTotp } from "@/lib/totp";
import { parseBody, twoFactorVerifySchema } from "@/lib/validate";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireAuth(req);
    if (!isAdminRole(user.role)) {
      throw forbidden("2FA solo aplica a roles administrativos");
    }
    const body = await parseBody(req, twoFactorVerifySchema);
    const tf = await db.twoFactor.findUnique({ where: { userId: user.id } });
    if (!tf) throw badRequest("Primero inicia la configuración de 2FA (setup)");
    if (tf.enabled) return NextResponse.json({ ok: true, message: "2FA ya estaba activo" });

    const secret = decryptSecret(tf.secretEncrypted);
    if (!verifyTotp(secret, body.code)) {
      throw badRequest("Código 2FA incorrecto o expirado");
    }
    await db.$transaction([
      db.twoFactor.update({
        where: { userId: user.id },
        data: { enabled: true, lastUsedAt: new Date() },
      }),
      db.user.update({
        where: { id: user.id },
        data: { mustReenroll2fa: false },
      }),
    ]);
    await logAudit({
      actorId: user.id,
      action: "auth.2fa.verify",
      entity: "TwoFactor",
      entityId: user.id,
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
