// POST /api/admin/raffles/[id]/draw/execute — ejecuta el sorteo: revela la
// semilla, calcula el ganador determinista, marca la rifa GANADOR_PUBLICADO
// y abre el caso del ganador. Bloqueado sin compromiso previo, con
// operaciones pendientes (P7) o si ya se sorteó (P8).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { executeDraw } from "@/lib/draw";
import { errorResponse } from "@/lib/errors";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "raffles.draw");
    const result = await executeDraw(id, user.id);
    await logAudit({
      actorId: user.id,
      action: "draws.execute",
      entity: "Draw",
      entityId: result.drawId,
      after: {
        raffleId: id,
        winnerTicketNumber: result.winnerTicketNumber,
        winnerTicketCode: result.winnerTicketCode,
        totalElegibles: result.totalElegibles,
        seedRevealed: true,
      },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
