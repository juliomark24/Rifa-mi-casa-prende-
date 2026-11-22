// POST /api/auth/2fa/disable — ADMIN*. Requiere contraseña + código 2FA
// vigente. Invalida el secreto anterior (se borra la fila) y queda en auditoría.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requireAuth, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse, forbidden, unauthorized } from "@/lib/errors";
import { isAdminRole } from "@/lib/permissions";
import { decryptSecret, verifyTotp } from "@/lib/totp";
import { parseBody, twoFactorDisableSchema } from "@/lib/validate";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireAuth(req);
    if (!isAdminRole(user.role)) {
      throw forbidden("2FA solo aplica a roles administrativos");
    }
    const body = await parseBody(req, twoFactorDisableSchema);
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      throw unauthorized("Contraseña incorrecta");
    }
    const tf = await db.twoFactor.findUnique({ where: { userId: user.id } });
    if (!tf?.enabled) throw badRequest("2FA no está activo para esta cuenta");
    const secret = decryptSecret(tf.secretEncrypted);
    if (!verifyTotp(secret, body.code)) {
      throw badRequest("Código 2FA incorrecto o expirado");
    }
    // Invalidación total del secreto anterior: se borra la fila.
    await db.twoFactor.delete({ where: { userId: user.id } });
    await logAudit({
      actorId: user.id,
      action: "auth.2fa.disable",
      entity: "TwoFactor",
      entityId: user.id,
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
