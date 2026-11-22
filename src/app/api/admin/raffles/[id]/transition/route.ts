// POST /api/admin/raffles/[id]/transition — máquina de 11 estados (§2.7).
// Cuerpo: {to, reason?}. La transición CANCELADA activa el registro de
// intención de reembolso (aviso a compradores; el flujo de reembolso es
// S5/S6). Programar (→ PROGRAMADA) exige país ACTIVO.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { applyRaffleTransition } from "@/lib/raffles";
import { parseBody, raffleTransitionSchema } from "@/lib/validate";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "raffles.transition");
    const body = await parseBody(req, raffleTransitionSchema);
    const updated = await applyRaffleTransition({
      raffleId: id,
      to: body.to,
      actorId: user.id,
      reason: body.reason ?? null,
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
