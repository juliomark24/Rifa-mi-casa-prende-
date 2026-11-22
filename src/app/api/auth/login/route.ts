// POST /api/auth/login — público.
// Si el usuario tiene 2FA activo: 202 {requires2FA:true} y el login se
// completa en POST /api/auth/login-2fa. Nunca se crea sesión sin el 2FA.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { createSession, publicUser, setSessionCookie, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse, unauthorized } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseBody, loginSchema } from "@/lib/validate";

// Hash ficticio para que un email inexistente tarde lo mismo que uno real.
const DUMMY_HASH = "$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRStuv";

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const body = await parseBody(req, loginSchema);
    // 10 intentos / 15 min por email: por encima del bloqueo de cuenta
    // (5 fallos), para que el bloqueo —y no el rate limit— responda.
    checkRateLimit(`login:${ip ?? "unknown"}:${body.email}`, { limit: 10, windowMs: 15 * 60 * 1000 });

    const user = await db.user.findUnique({ where: { email: body.email } });
    const passwordOk = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyPassword(body.password, DUMMY_HASH);

    if (!user || !passwordOk) {
      if (user) {
        const failed = user.failedLoginAttempts + 1;
        await db.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: failed,
            lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null,
          },
        });
      }
      throw unauthorized("Email o contraseña incorrectos");
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw unauthorized("Cuenta bloqueada temporalmente por demasiados intentos. Intenta más tarde.");
    }

    await db.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const twoFactor = await db.twoFactor.findUnique({ where: { userId: user.id } });
    if (twoFactor?.enabled) {
      // No se crea sesión todavía: falta el segundo factor.
      return NextResponse.json({ requires2FA: true, email: user.email }, { status: 202 });
    }

    const { token } = await createSession(user, {
      ipAddress: ip,
      userAgent: req.headers.get("user-agent"),
    });
    await logAudit({ actorId: user.id, action: "auth.login", entity: "User", entityId: user.id, ipAddress: ip });
    const res = NextResponse.json({ user: publicUser(user) });
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
