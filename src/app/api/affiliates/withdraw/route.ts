// POST /api/affiliates/withdraw — el afiliado solicita un retiro.
// {amount} entero ≥ mínimo configurable (def. RD$500), solo saldo
// AVAILABLE neto. Idempotente si se envía header Idempotency-Key.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { getMinWithdrawal, requestWithdrawal } from "@/lib/affiliates";
import { errorResponse } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { parseBody } from "@/lib/validate";

const withdrawSchema = z.object({
  amount: z.number().int("El monto debe ser entero").positive("El monto debe ser mayor que 0"),
  currency: z.string().trim().length(3, "La moneda debe ser ISO 4217 (3 letras)").toUpperCase().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireRole(req, ["AFILIADO"]);
    const body = await parseBody(req, withdrawSchema);
    const key = req.headers.get("Idempotency-Key")?.trim();
    const withdrawal = key
      ? await withIdempotency("affiliate-withdraw", key, () =>
          requestWithdrawal(user.id, { amount: body.amount, currency: body.currency }),
        )
      : await requestWithdrawal(user.id, { amount: body.amount, currency: body.currency });
    // El mínimo vigente se informa para que el frontend lo muestre.
    const minWithdrawal = await getMinWithdrawal();
    return NextResponse.json({ withdrawal, minWithdrawal }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
