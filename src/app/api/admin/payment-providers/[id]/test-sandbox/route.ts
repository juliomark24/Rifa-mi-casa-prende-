// POST /api/admin/payment-providers/[id]/test-sandbox — prueba de conexión
// en sandbox del adaptador. Guarda fecha y resultado en el proveedor.
// Sin credenciales/integración real → 503 NOT_CONFIGURED (regla 6).
import { NextRequest } from "next/server";
import { getClientIp } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { runSandboxTest } from "@/lib/payments/test-sandbox";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "paymentProviders.manage");
    return await runSandboxTest(id, user.id, getClientIp(req));
  } catch (err) {
    return errorResponse(err);
  }
}
