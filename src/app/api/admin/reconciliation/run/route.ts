// POST /api/admin/reconciliation/run — dispara la conciliación automática
// bajo demanda (job `reconcile-provider`, S5) vía runJob. Permiso
// payments.verify. Idempotente con header Idempotency-Key: repetir la
// misma clave devuelve el mismo resultado sin crear otro JobRun.
// La compensación de comisiones pagadas reembolsadas corre en su propio
// job (`compensate-paid-commissions`); no se dispara desde aquí.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { runJobByName } from "@/lib/jobs";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requirePermission(req, "payments.verify");
    const key = req.headers.get("Idempotency-Key")?.trim();
    const run = () => runJobByName("reconcile-provider");
    const result = key
      ? await withIdempotency("reconciliation-run", key, run)
      : await run();
    return NextResponse.json({ ...result, triggeredBy: user.id });
  } catch (err) {
    return errorResponse(err);
  }
}
