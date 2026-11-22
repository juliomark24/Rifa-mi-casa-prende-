// GET /api/admin/integrations — estado de cada proveedor preintegrado
// (Configuración Internacional). Un proveedor por adaptador del registro,
// con su estado operativo, gate (regla 6) y última prueba de sandbox.
// Las credenciales nunca se devuelven (solo si existen y sus claves).
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { ADAPTER_DEFAULT_STATUS, listAdapters, providerGateCheck, sanitizeProvider } from "@/lib/payments/registry";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "paymentProviders.view");
    const providers = await db.paymentProvider.findMany({ orderBy: { code: "asc" } });
    const byCode = new Map(providers.map((p) => [p.code, p]));
    const data = listAdapters().map((adapter) => {
      const row = byCode.get(adapter.code);
      const gate = row ? providerGateCheck(row) : { ok: false, reasons: ["Proveedor no registrado en BD"] };
      return {
        provider: adapter.code,
        name: adapter.name,
        type: adapter.type,
        defaultStatus: ADAPTER_DEFAULT_STATUS[adapter.code],
        status: row?.status ?? "NO_OPERATIVO",
        sandboxMode: row?.sandboxMode ?? true,
        credentialsConfigured: Boolean(row?.credentialsEncrypted),
        credentialKeys: row ? sanitizeProvider(row).credentialKeys : [],
        authorizedForRaffles: row?.authorizedForRaffles ?? false,
        lastSandboxTestAt: row?.lastSandboxTestAt ?? null,
        lastSandboxTestPassed: row?.lastSandboxTestPassed ?? null,
        verifiedAt: row?.verifiedAt ?? null,
        gate,
      };
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
