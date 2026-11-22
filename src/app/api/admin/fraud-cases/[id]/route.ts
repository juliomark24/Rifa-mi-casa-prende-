// PATCH /api/admin/fraud-cases/[id] — revisión humana de un caso de fraude.
// Cuerpo estandarizado: {riskStatus, decision?, note?}
// La decisión final es humana y queda registrada (plan §2.14). APROBADO /
// BLOQUEADO cierran el caso (resolvedAt); un caso cerrado solo se reabre
// a REVISION. Idempotente con header Idempotency-Key explícito.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { reviewFraudCase } from "@/lib/fraud";
import { withIdempotency } from "@/lib/idempotency";
import { parseBody, fraudPatchSchema } from "@/lib/validate";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "fraud.review");
    const body = await parseBody(req, fraudPatchSchema);
    const key = req.headers.get("Idempotency-Key")?.trim();
    const updated = key
      ? await withIdempotency("fraud-review", key, () =>
          reviewFraudCase(id, {
            riskStatus: body.riskStatus,
            decision: body.decision ?? null,
            note: body.note ?? null,
            actorId: user.id,
          }),
        )
      : await reviewFraudCase(id, {
          riskStatus: body.riskStatus,
          decision: body.decision ?? null,
          note: body.note ?? null,
          actorId: user.id,
        });
    return NextResponse.json({ data: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
