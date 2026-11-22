// POST /api/admin/withdrawals/[id]/approve — aprueba un retiro.
// Permiso withdrawals.approve. Doble aprobación (§2.20) si el monto
// supera WITHDRAWAL_DOUBLE_APPROVAL_THRESHOLD (def. 10.000): la primera
// aprobación lo deja REQUESTED con approvedById; la segunda, de OTRO
// admin, lo pasa a APPROVED. Idempotente con header Idempotency-Key.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { approveWithdrawal } from "@/lib/affiliates";
import { errorResponse } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "withdrawals.approve");
    const key = req.headers.get("Idempotency-Key")?.trim();
    // Solo con clave explícita se usa withIdempotency: la clave derivada
    // por admin enmascararía el 409 de doble aprobación (mismo admin dos
    // veces debe fallar, no devolver la respuesta cacheada). Sin clave,
    // la idempotencia la dan los guardas de estado de approveWithdrawal.
    const result = key
      ? await withIdempotency("withdraw-approve", key, () => approveWithdrawal(id, user.id))
      : await approveWithdrawal(id, user.id);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
