// GET /api/tickets/verify?code= — verificación pública por código.
// Devuelve si el boleto ganó, sin exponer datos privados del comprador.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/audit";
import { badRequest, errorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyTicket } from "@/lib/tickets";

export async function GET(req: NextRequest) {
  try {
    checkRateLimit(`verify:${getClientIp(req) ?? "unknown"}`, { limit: 60, windowMs: 60 * 1000 });
    const code = new URL(req.url).searchParams.get("code");
    if (!code || !code.trim()) throw badRequest("Falta el parámetro code");
    const result = await verifyTicket(code);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
