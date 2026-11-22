// GET /api/admin/draws/[id] — detalle admin de un sorteo (por id de Draw).
// La semilla solo se muestra tras la ejecución; antes, null.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { toPublicDraw } from "@/lib/draw";
import { errorResponse } from "@/lib/errors";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requirePermission(req, "raffles.view");
    const draw = await db.draw.findUnique({
      where: { id },
      include: {
        winningTicket: { select: { id: true, number: true, code: true, buyerName: true, buyerEmail: true } },
        raffle: { select: { id: true, title: true, prize: true, status: true, drawAt: true } },
      },
    });
    if (!draw) return NextResponse.json({ error: "Sorteo no existe" }, { status: 404 });
    const { winningTicket, raffle, ...rest } = draw;
    return NextResponse.json({
      data: {
        ...toPublicDraw(rest, winningTicket ? { id: winningTicket.id, number: winningTicket.number, code: winningTicket.code } : null),
        winnerBuyerName: winningTicket?.buyerName ?? null,
        winnerBuyerEmail: winningTicket?.buyerEmail ?? null,
        raffle,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
