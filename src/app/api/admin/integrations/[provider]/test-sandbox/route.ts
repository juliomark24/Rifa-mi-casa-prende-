// POST /api/admin/integrations/[provider]/test-sandbox — prueba en sandbox
// del proveedor indicado por su código (MANUAL_TRANSFER, PAYPAL, AZUL,
// CARDNET). Sin credenciales/integración real → 503 NOT_CONFIGURED.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { runSandboxTest } from "@/lib/payments/test-sandbox";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider } = await params;
    const { user } = await requirePermission(req, "paymentProviders.manage");
    const code = provider.toUpperCase();
    const row = await db.paymentProvider.findUnique({ where: { code } });
    if (!row) return NextResponse.json({ error: `Proveedor no existe: ${code}` }, { status: 404 });
    return await runSandboxTest(row.id, user.id, getClientIp(req));
  } catch (err) {
    return errorResponse(err);
  }
}
