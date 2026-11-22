// GET /api/orders/[code] — público por código: estado del pedido,
// boletos y pago. El código es el secreto de acceso (sin sesión).
import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { getOrderByCode, presentOrder } from "@/lib/orders";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await params;
    const order = await getOrderByCode(code);
    return NextResponse.json({
      order: presentOrder(order),
      tickets: order.tickets.map((t) => ({
        id: t.id,
        number: t.number,
        code: t.code,
        status: t.status,
      })),
      payment: order.payments[0]
        ? {
            status: order.payments[0].status,
            methodCode: order.payments[0].methodCode,
            amount: order.payments[0].amount,
            currency: order.payments[0].currency,
          }
        : null,
      raffle: order.raffle,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
