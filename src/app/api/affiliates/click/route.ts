// POST /api/affiliates/click — registra el clic de un afiliado.
// La página /r/[code] lo llama fire-and-forget. El clic alimenta la
// ventana de atribución de 7 días (último clic válido, plan §2.4).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/audit";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseBody, affiliateClickSchema } from "@/lib/validate";

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const body = await parseBody(req, affiliateClickSchema);
    checkRateLimit(`click:${ip ?? "unknown"}`, { limit: 30, windowMs: 60 * 1000 });

    const affiliate = await db.user.findFirst({
      where: { referralCode: body.code, role: "AFILIADO" },
    });
    if (!affiliate) return NextResponse.json({ error: "Código de afiliado no existe" }, { status: 404 });
    if (body.raffleId) {
      const raffle = await db.raffle.findUnique({ where: { id: body.raffleId } });
      if (!raffle) return NextResponse.json({ error: "Rifa no existe" }, { status: 404 });
    }
    const click = await db.click.create({
      data: {
        affiliateId: affiliate.id,
        raffleId: body.raffleId ?? null,
        code: body.code,
        clickedAt: new Date(),
        ipAddress: ip,
      },
    });
    return NextResponse.json({ ok: true, clickId: click.id });
  } catch (err) {
    return errorResponse(err);
  }
}
