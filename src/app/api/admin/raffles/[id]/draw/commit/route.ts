// POST /api/admin/raffles/[id]/draw/commit — congela elegibles y publica el
// compromiso (plan §2.5). Requiere rifa CERRADA, sin operaciones pendientes
// (P7) y sin sorteo previo (P8). Devuelve el compromiso público SIN la semilla.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { commitDraw } from "@/lib/draw";
import { errorResponse } from "@/lib/errors";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(_req, "raffles.draw");
    const result = await commitDraw(id, user.id);
    await logAudit({
      actorId: user.id,
      action: "draws.commit",
      entity: "Draw",
      entityId: result.drawId,
      after: {
        raffleId: id,
        commitment: result.commitment,
        hashElegibles: result.hashElegibles,
        totalElegibles: result.totalElegibles,
        algorithm: result.algorithm,
      },
      ipAddress: getClientIp(_req),
    });
    // La semilla NUNCA sale en esta respuesta (ver draw.ts).
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
