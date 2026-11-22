// POST /api/admin/withdrawals/[id]/reject — rechaza un retiro REQUESTED.
// Permiso withdrawals.approve. Cuerpo: {reason?}. Idempotente con header
// Idempotency-Key.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { rejectWithdrawal } from "@/lib/affiliates";
import { errorResponse } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { parseBody } from "@/lib/validate";

const rejectSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "withdrawals.approve");
    const body = await parseBody(req, rejectSchema);
    const key = req.headers.get("Idempotency-Key")?.trim();
    const withdrawal = key
      ? await withIdempotency("withdraw-reject", key, () => rejectWithdrawal(id, user.id, body.reason ?? null))
      : await rejectWithdrawal(id, user.id, body.reason ?? null);
    return NextResponse.json({ withdrawal });
  } catch (err) {
    return errorResponse(err);
  }
}
