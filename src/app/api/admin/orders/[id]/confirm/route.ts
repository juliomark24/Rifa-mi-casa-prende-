// POST /api/admin/orders/[id]/confirm — el admin verifica la transferencia
// manual (referencia/comprobante) y CONFIRMA el pedido (plan §2.2, P2):
// Payment PENDIENTE → APROBADO, Order PENDIENTE → CONFIRMADO, tickets
// RESERVADO → VENDIDO, asiento VENTA en ledger y comisión PENDIENTE del
// 10% si hay afiliado. Permiso orders.confirm (FINANZAS / SUPERADMIN).
// Idempotente: header Idempotency-Key opcional (sin él se deriva de la
// orden); confirmar dos veces no duplica asientos ni boletos.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { confirmOrderPayment } from "@/lib/payments/operations";
import { parseBody } from "@/lib/validate";

const confirmSchema = z.object({
  /** Referencia de la transferencia / comprobante verificado por el admin. */
  reference: z.string().trim().min(1, "La referencia del pago es obligatoria").max(200),
  /** Referencia del comprobante (archivo/recibo) si el admin la registra. */
  receiptRef: z.string().trim().max(200).optional(),
  /** Monto verificado por el admin; si difiere del total → 409 + caso. */
  amount: z.number().int("El monto debe ser entero").positive("El monto debe ser mayor que 0").optional(),
  reason: z.string().trim().max(2000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "orders.confirm");
    const body = await parseBody(req, confirmSchema);
    const key = req.headers.get("Idempotency-Key")?.trim() || `confirm:${id}`;
    const result = await withIdempotency("order-confirm", key, () =>
      confirmOrderPayment(id, {
        actorId: user.id,
        reference: body.reference,
        receiptRef: body.receiptRef ?? null,
        amount: body.amount,
        reason: body.reason ?? null,
        source: "admin",
      }),
    );
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
