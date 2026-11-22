// Utilidades compartidas por los tests S2.
import { NextRequest } from "next/server";
import { createSession, hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { resetRateLimitStore } from "@/lib/rate-limit";
import type { Role, User } from "../src/generated/prisma/client";

/** Limpia TODAS las tablas (orden seguro por FK) y el rate limiter en memoria. */
export async function cleanDb() {
  resetRateLimitStore();
  await db.auditLog.deleteMany();
  await db.configHistory.deleteMany();
  await db.notification.deleteMany();
  await db.supportTicket.deleteMany();
  await db.fraudCase.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.idempotencyKey.deleteMany();
  await db.jobRun.deleteMany();
  await db.reconciliationCase.deleteMany();
  await db.ledgerEntry.deleteMany();
  await db.commission.deleteMany();
  await db.withdrawal.deleteMany();
  await db.click.deleteMany();
  await db.payment.deleteMany();
  await db.order.deleteMany();
  await db.ticket.deleteMany();
  await db.reservation.deleteMany();
  await db.draw.deleteMany();
  await db.winnerCase.deleteMany();
  await db.termsAcceptance.deleteMany();
  await db.raffleTerms.deleteMany();
  await db.raffle.deleteMany();
  await db.countryPaymentConfig.deleteMany();
  await db.paymentMethod.deleteMany();
  await db.paymentProvider.deleteMany();
  await db.country.deleteMany();
  await db.recoveryRequest.deleteMany();
  await db.session.deleteMany();
  await db.twoFactor.deleteMany();
  await db.user.deleteMany();
  await db.setting.deleteMany();
}

let userCounter = 0;

export async function createUser(
  opts: { role?: Role; email?: string; password?: string; name?: string } = {},
): Promise<User> {
  userCounter += 1;
  const role = opts.role ?? "CLIENTE";
  const email = opts.email ?? `user${userCounter}@test.do`;
  return db.user.create({
    data: {
      name: opts.name ?? "Usuario Test",
      email,
      passwordHash: await hashPassword(opts.password ?? "Password123!"),
      role,
    },
  });
}

/** Crea sesión real y devuelve el token JWT (para la cookie). */
export async function loginToken(user: User): Promise<string> {
  const { token } = await createSession(user, { ipAddress: "127.0.0.1" });
  return token;
}

export function makeRequest(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["cookie"] = `pr_session=${opts.token}`;
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export function getCookieToken(res: Response): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/pr_session=([^;]+)/);
  return match ? match[1] : null;
}

/** Proveedores preintegrados (como el seed) para tests de integraciones. */
export async function seedProviders() {
  const manual = await db.paymentProvider.create({
    data: { code: "MANUAL_TRANSFER", name: "Transferencia manual", type: "MANUAL", status: "OPERATIVO", sandboxMode: false, authorizedForRaffles: true, verifiedAt: new Date() },
  });
  const paypal = await db.paymentProvider.create({
    data: { code: "PAYPAL", name: "PayPal", type: "GATEWAY", status: "NO_OPERATIVO", sandboxMode: true },
  });
  const azul = await db.paymentProvider.create({
    data: { code: "AZUL", name: "Azul (Banco Popular)", type: "GATEWAY", status: "NO_OPERATIVO", sandboxMode: true },
  });
  const cardnet = await db.paymentProvider.create({
    data: { code: "CARDNET", name: "CardNet (Banreservas)", type: "GATEWAY", status: "NO_OPERATIVO", sandboxMode: true },
  });
  return { manual, paypal, azul, cardnet };
}
