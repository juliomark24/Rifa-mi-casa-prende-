// GET /api/draws/[raffleId] — resultado público verificable (contrato).
// 404 si la rifa no existe o si el sorteo aún no se ejecutó. Tras ejecutar,
// devuelve commitment, semilla revelada, hashElegibles, la lista congelada
// (eligibleSnapshot, necesaria para reproducir el sorteo), totalElegibles,
// boleto ganador, algoritmo, executedAt y drawId.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPublicDraw } from "@/lib/draw";
import { errorResponse } from "@/lib/errors";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ raffleId: string }> },
) {
  try {
    const { raffleId } = await params;
    const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
    if (!raffle) return NextResponse.json({ error: "Rifa no existe" }, { status: 404 });
    const draw = await db.draw.findUnique({
      where: { raffleId },
      include: { winningTicket: { select: { id: true, number: true, code: true } } },
    });
    if (!draw || !draw.executedAt) {
      return NextResponse.json({ error: "El sorteo aún no se ha ejecutado" }, { status: 404 });
    }
    return NextResponse.json(toPublicDraw(draw, draw.winningTicket));
  } catch (err) {
    return errorResponse(err);
  }
}
