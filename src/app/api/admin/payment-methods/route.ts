// GET / POST /api/admin/payment-methods — métodos de pago (contrato v2.2).
// S9-int: las rutas no existían aunque el contrato las define y el panel
// admin (metodos-pago, paises, PaymentIntegrations, AdminActions) las usa.
// GET lista los métodos con su proveedor y sus configuraciones por país;
// POST crea el método (código ÚNICO en el schema) y su configuración
// habilitada para el país indicado. El proveedor se resuelve por código
// de método (MANUAL_TRANSFER → MANUAL_TRANSFER, PAYPAL → PAYPAL,
// AZUL_CARD → AZUL, CARDNET_CARD → CARDNET). La configuración fina del
// proveedor (credenciales, sandbox, activación con gate) NO vive aquí:
// se gestiona en /api/admin/payment-providers y /api/admin/integrations.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { conflict, errorResponse, notFound } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { METHOD_PROVIDER, presentPaymentMethod } from "@/lib/payment-methods";
import {
  parseBody,
  paymentMethodCreateSchema,
} from "@/lib/validate";

const include = {
  provider: { select: { code: true, name: true, status: true, sandboxMode: true } },
  configs: {
    include: { country: { select: { code: true, currencyCode: true } } },
    orderBy: { priority: "asc" as const },
  },
};

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "paymentProviders.view");
    const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "20") || 20));
    const [methods, total] = await Promise.all([
      db.paymentMethod.findMany({ include, orderBy: { code: "asc" }, skip: (page - 1) * limit, take: limit }),
      db.paymentMethod.count(),
    ]);
    return NextResponse.json({ data: methods.map(presentPaymentMethod), page, total });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requirePermission(req, "paymentProviders.manage");
    const body = await parseBody(req, paymentMethodCreateSchema);
    const country = await db.country.findUnique({ where: { code: body.country } });
    if (!country) throw notFound(`País no existe: ${body.country} (créalo primero en /admin/paises)`);
    if (country.currencyCode !== body.currency) {
      throw conflict(
        `La moneda del país ${country.code} es ${country.currencyCode}, no ${body.currency}`,
        "CURRENCY_MISMATCH",
      );
    }
    const providerCode = METHOD_PROVIDER[body.code];
    const provider = await db.paymentProvider.findUnique({ where: { code: providerCode } });
    if (!provider) throw notFound(`Proveedor no registrado: ${providerCode}`);
    const existing = await db.paymentMethod.findUnique({ where: { code: body.code } });
    if (existing) {
      throw conflict(
        `El método ${body.code} ya existe (el código es único); edítalo o habilítalo por país en vez de crearlo de nuevo`,
        "METHOD_ALREADY_EXISTS",
      );
    }
    const method = await db.$transaction(async (tx) => {
      const created = await tx.paymentMethod.create({
        data: {
          code: body.code,
          providerId: provider.id,
          label: body.label,
          details: body.details ?? "",
          enabled: body.enabled ?? true,
        },
      });
      await tx.countryPaymentConfig.create({
        data: {
          countryId: country.id,
          providerId: provider.id,
          methodId: created.id,
          priority: 1,
          enabled: body.enabled ?? true,
        },
      });
      return created;
    });
    const full = await db.paymentMethod.findUniqueOrThrow({ where: { id: method.id }, include });
    await logAudit({
      actorId: user.id,
      action: "payments.method.create",
      entity: "PaymentMethod",
      entityId: method.id,
      after: { code: body.code, country: body.country, label: body.label, enabled: body.enabled ?? true },
    });
    return NextResponse.json({ data: presentPaymentMethod(full) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
