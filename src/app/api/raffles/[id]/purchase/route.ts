// POST /api/raffles/[id]/purchase — crea el pedido (PENDIENTE + Payment
// PENDIENTE + tickets RESERVADO). Compra invitada, sin registro
// obligatorio. Requiere header Idempotency-Key: repetir la misma clave
// devuelve el mismo pedido sin efectos duplicados (plan §2.12, P20).
// MANUAL_TRANSFER devuelve las instrucciones de transferencia; los demás
// métodos responden 503 NOT_CONFIGURED hasta verificación real (regla 6).
// El código de afiliado llega en el body o en la cookie pr_ref (la página
// /r/[code] la guarda 30 días); sin código, se usa el último clic válido.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/audit";
import { errorResponse } from "@/lib/errors";
import { createOrder, purchaseSchema } from "@/lib/orders";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseBody } from "@/lib/validate";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    checkRateLimit(`purchase:${getClientIp(req) ?? "unknown"}`, { limit: 20, windowMs: 60 * 1000 });
    const idempotencyKey = req.headers.get("Idempotency-Key");
    if (!idempotencyKey || !idempotencyKey.trim()) {
      return NextResponse.json(
        { error: "Falta el header Idempotency-Key", code: "IDEMPOTENCY_KEY_REQUIRED" },
        { status: 400 },
      );
    }
    const body = await parseBody(req, purchaseSchema);
    const cookieCode = req.cookies.get("pr_ref")?.value ?? null;
    const result = await createOrder({
      raffleId: id,
      buyerName: body.buyerName,
      buyerEmail: body.buyerEmail,
      buyerPhone: body.buyerPhone ?? null,
      paymentMethodCode: body.paymentMethodCode,
      reservationId: body.reservationId ?? null,
      numbers: body.numbers,
      quantity: body.quantity,
      affiliateCode: body.affiliateCode ?? cookieCode,
      useLatestClick: true,
      idempotencyKey: idempotencyKey.trim(),
      acceptTerms: body.acceptTerms,
    });
    const { order, tickets, paymentInstructions } = result;
    return NextResponse.json(
      { order, tickets, paymentInstructions },
      { status: result.created ? 201 : 200 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
