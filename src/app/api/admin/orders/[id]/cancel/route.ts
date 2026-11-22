// POST /api/admin/orders/[id]/cancel — cancela un pedido PENDIENTE y
// libera sus boletos (permiso orders.cancel). Un pedido CONFIRMADO no se
// cancela por aquí: necesita el flujo de reembolso (S6).
// NOTA S4: POST /api/admin/orders/[id]/confirm y /refund son S5/S6 y NO
// existen todavía: si el frontend los llama, responderán 404.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { cancelOrder } from "@/lib/orders";
import { parseBody } from "@/lib/validate";
import { z } from "zod";

const cancelSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "orders.cancel");
    // El body es opcional (el motivo puede venir vacío).
    const body = await parseBody(req, cancelSchema).catch(() => ({ reason: undefined }));
    const order = await cancelOrder(id, { actorId: user.id, reason: body.reason });
    return NextResponse.json({ order });
  } catch (err) {
    return errorResponse(err);
  }
}
