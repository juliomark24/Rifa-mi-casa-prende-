// GET /api/payment-methods — métodos de pago habilitados para un país
// (checkout dinámico, contrato v2.2; plan §2.2, P16).
// S9-int: la ruta no existía aunque el contrato la define y PurchaseForm
// la usa para cargar el checkout. Sin ella el checkout no podía mostrar
// ningún método (404 → "No se pudieron cargar los métodos de pago").
//
// Solo se devuelven métodos REALMENTE disponibles para ese país:
//  - CountryPaymentConfig habilitada para el país + método habilitado +
//    proveedor OPERATIVO (regla 6: solo MANUAL_TRANSFER opera en Fase 1).
// Sin ?country=, se devuelven los métodos habilitados con proveedor
// OPERATIVO (sin filtro por país). Un país desconocido devuelve lista
// vacía (el checkout muestra "sin métodos habilitados", no un error).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const countryParam = req.nextUrl.searchParams.get("country")?.trim().toUpperCase() || null;
    if (countryParam) {
      const country = await db.country.findUnique({ where: { code: countryParam } });
      if (!country) return NextResponse.json({ data: [] });
      const configs = await db.countryPaymentConfig.findMany({
        where: { countryId: country.id, enabled: true },
        include: {
          method: true,
          provider: { select: { code: true, status: true } },
        },
        orderBy: { priority: "asc" },
      });
      const data = configs
        .filter((c) => c.method.enabled && c.provider.status === "OPERATIVO")
        .map((c) => ({
          code: c.method.code,
          label: c.method.label,
          details: c.method.details,
          provider: c.provider.code,
          currency: country.currencyCode,
        }));
      return NextResponse.json({ data });
    }
    const methods = await db.paymentMethod.findMany({
      include: { provider: { select: { code: true, status: true } } },
      orderBy: { code: "asc" },
    });
    return NextResponse.json({
      data: methods
        .filter((m) => m.enabled && m.provider.status === "OPERATIVO")
        .map((m) => ({
          code: m.code,
          label: m.label,
          details: m.details,
          provider: m.provider.code,
        })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
