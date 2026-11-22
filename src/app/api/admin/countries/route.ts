// /api/admin/countries — Configuración Internacional (plan §2.9).
// GET — lista de países con su clasificación A/B/C y su gate.
// POST — "Agregar país" (16 campos del plan §2.9). El país nace en
// BORRADOR/CONFIGURACION/REVISION; activar exige el gate de
// POST /api/admin/countries/[id]/activate (P18).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit, toJsonValue } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { buildCountryProfile } from "@/lib/countries";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { parseBody, countryCreateSchema } from "@/lib/validate";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "countries.view");
    const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "20") || 20));
    const [total, countries] = await Promise.all([
      db.country.count(),
      db.country.findMany({
        orderBy: { code: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return NextResponse.json({ data: countries.map(buildCountryProfile), page, total });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requirePermission(req, "countries.manage");
    const body = await parseBody(req, countryCreateSchema);
    const existing = await db.country.findUnique({ where: { code: body.code } });
    if (existing) {
      return NextResponse.json(
        { error: `Ya existe un país con el código ${body.code}` },
        { status: 409 },
      );
    }

    // Resolver proveedores y métodos antes de crear nada.
    const paymentConfigs: {
      providerId: string;
      methodId: string;
      priority: number;
      feeFixed: number;
      feePercentBps: number;
      limits: unknown;
      enabled: boolean;
    }[] = [];
    for (const pm of body.paymentMethods ?? []) {
      const provider = await db.paymentProvider.findUnique({ where: { code: pm.providerCode } });
      if (!provider) {
        return NextResponse.json(
          { error: `Proveedor no existe: ${pm.providerCode}` },
          { status: 400 },
        );
      }
      const method = await db.paymentMethod.findUnique({ where: { code: pm.methodCode } });
      if (!method) {
        return NextResponse.json(
          { error: `Método de pago no existe: ${pm.methodCode}` },
          { status: 400 },
        );
      }
      if (method.providerId !== provider.id) {
        return NextResponse.json(
          { error: `El método ${pm.methodCode} no pertenece al proveedor ${pm.providerCode}` },
          { status: 400 },
        );
      }
      paymentConfigs.push({
        providerId: provider.id,
        methodId: method.id,
        priority: pm.priority,
        feeFixed: pm.feeFixed,
        feePercentBps: pm.feePercentBps,
        limits: pm.limits ?? null,
        enabled: pm.enabled,
      });
    }

    const country = await db.$transaction(async (tx) => {
      const created = await tx.country.create({
        data: {
          code: body.code,
          name: body.name,
          flag: body.flag ?? null,
          currencyCode: body.currencyCode,
          currencySymbol: body.currencySymbol,
          currencyFormat: body.currencyFormat ?? null,
          defaultLanguage: body.defaultLanguage,
          availableLanguages: body.availableLanguages,
          timezone: body.timezone,
          dateFormat: body.dateFormat,
          timeFormat: body.timeFormat ?? null,
          allowedCountries: toJsonValue(body.allowedCountries),
          blockedCountries: toJsonValue(body.blockedCountries),
          legalConfig: toJsonValue(body.legalConfig),
          notificationConfig: toJsonValue(body.notificationConfig),
          refundRules: toJsonValue(body.refundRules),
          classification: body.classification,
          status: body.status,
          legalVerified: body.legalVerified,
          providerVerified: body.providerVerified,
        },
      });
      for (const cfg of paymentConfigs) {
        await tx.countryPaymentConfig.create({
          data: { ...cfg, countryId: created.id, limits: toJsonValue(cfg.limits) },
        });
      }
      await tx.configHistory.create({
        data: {
          entity: "Country",
          entityId: created.id,
          changedById: user.id,
          before: toJsonValue(null),
          after: { code: created.code, name: created.name, status: created.status, classification: created.classification },
          reason: "Agregar país",
        },
      });
      return created;
    });

    await logAudit({
      actorId: user.id,
      action: "countries.create",
      entity: "Country",
      entityId: country.id,
      after: { code: country.code, name: country.name, status: country.status },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: buildCountryProfile(country) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
