// POST /api/raffles/[id]/reserve — crea una reserva temporal (~10 min).
// Requiere header Idempotency-Key (contrato v2.2).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/audit";
import { errorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { createReservation, reserveSchema } from "@/lib/reservations";
import { parseBody } from "@/lib/validate";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    checkRateLimit(`reserve:${getClientIp(req) ?? "unknown"}`, { limit: 30, windowMs: 60 * 1000 });
    const idempotencyKey = req.headers.get("Idempotency-Key");
    if (!idempotencyKey || !idempotencyKey.trim()) {
      return NextResponse.json(
        { error: "Falta el header Idempotency-Key", code: "IDEMPOTENCY_KEY_REQUIRED" },
        { status: 400 },
      );
    }
    const body = await parseBody(req, reserveSchema);
    const result = await createReservation({
      raffleId: id,
      buyerEmail: body.buyerEmail,
      userId: body.userId ?? null,
      numbers: body.numbers,
      quantity: body.quantity,
      idempotencyKey: idempotencyKey.trim(),
    });
    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
