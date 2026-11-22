// GET /api/admin/payment-providers — integraciones de pago (Configuración
// Internacional). Lista cada proveedor preintegrado con su estado real:
// código, adaptador, estado operativo, modo sandbox, referencia de
// credenciales (nunca el secreto), última prueba de sandbox y gate.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { ADAPTER_DEFAULT_STATUS, listAdapters, sanitizeProvider } from "@/lib/payments/registry";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "paymentProviders.view");
    const providers = await db.paymentProvider.findMany({
      orderBy: { code: "asc" },
      include: { _count: { select: { configs: true } } },
    });
    const adapters = Object.fromEntries(
      listAdapters().map((a) => [
        a.code,
        { name: a.name, type: a.type, defaultStatus: ADAPTER_DEFAULT_STATUS[a.code] },
      ]),
    );
    return NextResponse.json({
      data: providers.map((p) => ({
        ...sanitizeProvider(p),
        adapter: adapters[p.code] ?? null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
