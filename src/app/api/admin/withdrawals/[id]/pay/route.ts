// POST /api/admin/withdrawals/[id]/pay — paga un retiro APPROVED.
// Permiso withdrawals.pay. Crea el asiento RETIRO en ledger + marca PAID
// las comisiones AVAILABLE más antiguas (FIFO) hasta cubrir el monto,
// en una transacción. Sin aprobación registrada no se paga (regla dura).
// Cuerpo: {receiptRef?}. Idempotente con header Idempotency-Key.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { payWithdrawal } from "@/lib/affiliates";
import { errorResponse } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { parseBody } from "@/lib/validate";

const paySchema = z.object({
  receiptRef: z.string().trim().max(200).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "withdrawals.pay");
    const body = await parseBody(req, paySchema);
    const key = req.headers.get("Idempotency-Key")?.trim();
    const result = key
      ? await withIdempotency("withdraw-pay", key, () => payWithdrawal(id, user.id, body.receiptRef ?? null))
      : await payWithdrawal(id, user.id, body.receiptRef ?? null);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
