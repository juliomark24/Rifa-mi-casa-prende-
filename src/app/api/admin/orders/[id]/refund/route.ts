// POST /api/admin/orders/[id]/refund — reembolsa un pedido CONFIRMADO
// (plan §2.3, §2.4, P6): Payment APROBADO → REEMBOLSADO, Order
// CONFIRMADO → REEMBOLSADO, boletos VENDIDO → DISPONIBLE (rifa aún
// abierta) o ANULADO (rifa cerrada/sorteada), asiento REEMBOLSO
// compensatorio en ledger (nunca se borra la VENTA) y ajuste de la
// comisión vía adjustCommissionsForRefund. Permiso orders.refund
// (FINANZAS / SUPERADMIN). Un pedido PENDIENTE → 400 (no hay cobro que
// devolver). Idempotente por Idempotency-Key (o derivada de la orden).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { refundOrderPayment } from "@/lib/payments/operations";
import { parseBody } from "@/lib/validate";

const refundSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
  /** Referencia del reembolso en el proveedor (si lo ejecutó la pasarela). */
  providerRef: z.string().trim().max(200).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "orders.refund");
    const body = await parseBody(req, refundSchema);
    const key = req.headers.get("Idempotency-Key")?.trim() || `refund:${id}`;
    const result = await withIdempotency("order-refund", key, () =>
      refundOrderPayment(id, {
        actorId: user.id,
        reason: body.reason ?? null,
        providerRef: body.providerRef ?? null,
        source: "admin",
      }),
    );
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
