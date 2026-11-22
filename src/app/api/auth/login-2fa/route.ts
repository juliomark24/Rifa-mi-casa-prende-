// POST /api/auth/login-2fa — completa el login cuando el usuario tiene 2FA.
// Acepta código TOTP vigente o un código de respaldo (de un solo uso).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { createSession, publicUser, setSessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse, unauthorized } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { consumeBackupCode, decryptSecret, verifyTotp } from "@/lib/totp";
import { parseBody, login2faSchema } from "@/lib/validate";

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const body = await parseBody(req, login2faSchema);
    checkRateLimit(`login-2fa:${ip ?? "unknown"}:${body.email}`, { limit: 5, windowMs: 15 * 60 * 1000 });

    const user = await db.user.findUnique({ where: { email: body.email } });
    if (!user) throw unauthorized("Email o código incorrectos");
    const tf = await db.twoFactor.findUnique({ where: { userId: user.id } });
    if (!tf?.enabled) throw unauthorized("Esta cuenta no tiene 2FA activo");

    const secret = decryptSecret(tf.secretEncrypted);
    let ok = verifyTotp(secret, body.code);
    let usedBackup = false;
    if (!ok && Array.isArray(tf.backupCodesHash) && tf.backupCodesHash.length > 0) {
      const remaining = await consumeBackupCode(tf.backupCodesHash as string[], body.code);
      if (remaining) {
        ok = true;
        usedBackup = true;
        await db.twoFactor.update({
          where: { userId: user.id },
          data: { backupCodesHash: remaining },
        });
      }
    }
    if (!ok) throw unauthorized("Código 2FA incorrecto o expirado");

    await db.twoFactor.update({
      where: { userId: user.id },
      data: { lastUsedAt: new Date() },
    });
    const { token } = await createSession(user, {
      ipAddress: ip,
      userAgent: req.headers.get("user-agent"),
    });
    await logAudit({
      actorId: user.id,
      action: usedBackup ? "auth.login-2fa-backup" : "auth.login-2fa",
      entity: "User",
      entityId: user.id,
      ipAddress: ip,
    });
    const res = NextResponse.json({ user: publicUser(user) });
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
