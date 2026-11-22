// Autenticación: JWT (jose) + cookie httpOnly `pr_session` + sesiones
// revocables en BD. El rol NUNCA viene del cliente: viene de la sesión.
// Sin tokens en localStorage. Sin fallback débil de JWT_SECRET en producción.
import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Role, User } from "../generated/prisma/client";
import { db } from "./db";
import { forbidden, unauthorized } from "./errors";
import { hasPermission, isAdminRole, type Permission } from "./permissions";
import { hashToken } from "./totp";

export const SESSION_COOKIE = "pr_session";
const SESSION_DAYS = 7;

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET no configurado o demasiado corto (mín. 32 caracteres)");
    }
    // Solo desarrollo/tests.
    return new TextEncoder().encode("dev-only-jwt-secret-min-32-chars-long!!");
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---------------------------------------------------------------- sesiones
export type SessionContext = {
  user: User;
  sessionId: string;
};

export async function createSession(
  user: User,
  opts?: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ token: string; sessionId: string }> {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const session = await db.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(jti),
      expiresAt,
      ipAddress: opts?.ipAddress ?? null,
      userAgent: opts?.userAgent ?? null,
    },
  });
  const token = await new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(getJwtSecret());
  return { token, sessionId: session.id };
}

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ---------------------------------------------------------------- usuario actual
/** Devuelve el usuario de la sesión o null (sin lanzar). */
export async function getCurrentUser(req: NextRequest): Promise<SessionContext | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    const jti = payload.jti;
    const userId = payload.sub;
    if (!jti || !userId) return null;
    const session = await db.session.findUnique({ where: { tokenHash: hashToken(jti) } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
    if (session.userId !== userId) return null;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    return { user, sessionId: session.id };
  } catch {
    return null;
  }
}

export async function requireAuth(req: NextRequest): Promise<SessionContext> {
  const ctx = await getCurrentUser(req);
  if (!ctx) throw unauthorized();
  return ctx;
}

export async function requireRole(req: NextRequest, roles: Role[]): Promise<SessionContext> {
  const ctx = await requireAuth(req);
  if (!roles.includes(ctx.user.role)) {
    throw forbidden(`El rol ${ctx.user.role} no puede realizar esta acción`);
  }
  assertAdmin2faReady(ctx.user);
  return ctx;
}

export async function requirePermission(
  req: NextRequest,
  permission: Permission,
): Promise<SessionContext> {
  const ctx = await requireAuth(req);
  if (!hasPermission(ctx.user.role, permission)) {
    throw forbidden(`El rol ${ctx.user.role} no tiene el permiso ${permission}`);
  }
  assertAdmin2faReady(ctx.user);
  return ctx;
}

/**
 * Un admin que debe re-enrolar 2FA (tras recuperación) no puede hacer
 * acciones administrativas hasta completar setup + verify de 2FA.
 * Las rutas de 2fa/setup y 2fa/verify usan requireAuth directamente.
 */
export function assertAdmin2faReady(user: User): void {
  if (isAdminRole(user.role) && user.mustReenroll2fa) {
    throw forbidden(
      "Debes completar la configuración de 2FA antes de realizar acciones administrativas",
      "REQUIRES_2FA_SETUP",
    );
  }
}

/** El usuario admin tiene 2FA activo (para aprobar recuperaciones, etc.). */
export async function userHas2faEnabled(userId: string): Promise<boolean> {
  const tf = await db.twoFactor.findUnique({ where: { userId } });
  return Boolean(tf?.enabled);
}

// ---------------------------------------------------------------- presentación
export function publicUser(user: User): {
  id: string;
  name: string;
  email: string;
  role: Role;
  referralCode?: string | null;
} {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    referralCode: user.referralCode,
  };
}

export async function generateReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
    const code = `PRENDE${suffix}`;
    const existing = await db.user.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }
  throw new Error("No se pudo generar un código de referido único");
}
