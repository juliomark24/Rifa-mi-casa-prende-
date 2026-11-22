// GET /api/winners — ganadores publicados (público).
// Solo número de boleto + rifa + fecha: sin datos personales (no existe en
// el schema un campo de consentimiento del ganador para publicar su nombre,
// así que winnerName siempre es null). Paginación ?page=&limit=.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "20") || 20));
    const where = { executedAt: { not: null } };
    const [total, draws] = await Promise.all([
      db.draw.count({ where }),
      db.draw.findMany({
        where,
        include: {
          raffle: { select: { id: true, title: true, prize: true, drawAt: true } },
          winningTicket: { select: { number: true, code: true } },
        },
        orderBy: { executedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const data = draws
      .filter((d) => d.winningTicket)
      .map((d) => ({
        drawId: d.id,
        raffleId: d.raffleId,
        raffleTitle: d.raffle.title,
        prize: d.raffle.prize,
        winnerTicketNumber: d.winningTicket!.number,
        winnerTicketCode: d.winningTicket!.code,
        winnerName: null,
        executedAt: d.executedAt,
        drawAt: d.raffle.drawAt,
      }));
    return NextResponse.json({ data, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
