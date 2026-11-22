// POST /api/auth/register-afiliado — público. Crea AFILIADO + referralCode único.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { generateReferralCode, hashPassword, publicUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseBody, registerSchema } from "@/lib/validate";

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    checkRateLimit(`register-afiliado:${ip ?? "unknown"}`, { limit: 5, windowMs: 60 * 60 * 1000 });
    const body = await parseBody(req, registerSchema);
    const existing = await db.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return NextResponse.json({ error: "Ya existe una cuenta con ese email" }, { status: 409 });
    }
    const user = await db.user.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: "AFILIADO", // fijado por el servidor, nunca por el cliente
        referralCode: await generateReferralCode(),
      },
    });
    await logAudit({ action: "auth.register-afiliado", entity: "User", entityId: user.id, ipAddress: ip });
    return NextResponse.json({ user: publicUser(user) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
