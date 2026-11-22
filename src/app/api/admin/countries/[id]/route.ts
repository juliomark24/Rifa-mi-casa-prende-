// GET /api/admin/countries/[id] — detalle de un país con su configuración
// de pagos por proveedor/método.
// PATCH — edita el país. ACTIVO no se admite aquí: activar exige el gate
// de POST /api/admin/countries/[id]/activate (P18). Cada cambio queda en
// ConfigHistory + AuditLog (§2.20).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit, logChange, toJsonValue } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { parseBody, countryPatchSchema } from "@/lib/validate";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requirePermission(req, "countries.view");
    const country = await db.country.findUnique({
      where: { id },
      include: {
        paymentConfigs: {
          include: {
            provider: { select: { code: true, name: true, status: true } },
            method: { select: { code: true, label: true } },
          },
          orderBy: { priority: "asc" },
        },
      },
    });
    if (!country) return NextResponse.json({ error: "País no existe" }, { status: 404 });
    return NextResponse.json({ data: country });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "countries.manage");
    const body = await parseBody(req, countryPatchSchema);
    const before = await db.country.findUnique({ where: { id } });
    if (!before) return NextResponse.json({ error: "País no existe" }, { status: 404 });

    // Resolver la nueva configuración de pagos antes de tocar nada.
    const paymentConfigs: {
      providerId: string;
      methodId: string;
      priority: number;
      feeFixed: number;
      feePercentBps: number;
      limits: unknown;
      enabled: boolean;
    }[] | null = body.paymentMethods
      ? await Promise.all(
          body.paymentMethods.map(async (pm) => {
            const provider = await db.paymentProvider.findUnique({ where: { code: pm.providerCode } });
            if (!provider) throw new Error(`Proveedor no existe: ${pm.providerCode}`);
            const method = await db.paymentMethod.findUnique({ where: { code: pm.methodCode } });
            if (!method) throw new Error(`Método de pago no existe: ${pm.methodCode}`);
            if (method.providerId !== provider.id) {
              throw new Error(`El método ${pm.methodCode} no pertenece al proveedor ${pm.providerCode}`);
            }
            return {
              providerId: provider.id,
              methodId: method.id,
              priority: pm.priority,
              feeFixed: pm.feeFixed,
              feePercentBps: pm.feePercentBps,
              limits: pm.limits ?? null,
              enabled: pm.enabled,
            };
          }),
        )
      : null;

    const { reason, paymentMethods: _ignored, ...fields } = body;
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === "legalConfig" || key === "notificationConfig" || key === "refundRules") {
        data[key] = toJsonValue(value);
      } else {
        data[key] = value;
      }
    }

    const updated = await db.$transaction(async (tx) => {
      const country =
        Object.keys(data).length > 0
          ? await tx.country.update({ where: { id }, data })
          : await tx.country.findUniqueOrThrow({ where: { id } });
      if (paymentConfigs !== null) {
        await tx.countryPaymentConfig.deleteMany({ where: { countryId: id } });
        for (const cfg of paymentConfigs) {
          await tx.countryPaymentConfig.create({
            data: { ...cfg, countryId: id, limits: toJsonValue(cfg.limits) },
          });
        }
      }
      await tx.configHistory.create({
        data: {
          entity: "Country",
          entityId: id,
          changedById: user.id,
          before: { status: before.status, classification: before.classification, legalVerified: before.legalVerified, providerVerified: before.providerVerified },
          after: { ...data, paymentMethods: paymentConfigs !== null ? paymentConfigs.length : undefined },
          reason: reason ?? null,
        },
      });
      return country;
    });

    for (const [key, value] of Object.entries(data)) {
      await logChange({
        actorId: user.id,
        entity: "Country",
        entityId: id,
        field: key,
        beforeValue: before[key as keyof typeof before],
        afterValue: value,
        reason: reason ?? null,
      });
    }
    await logAudit({
      actorId: user.id,
      action: "countries.update",
      entity: "Country",
      entityId: id,
      before: { code: before.code, status: before.status },
      after: { ...data },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Proveedor no existe")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof Error && err.message.startsWith("Método de pago no existe")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof Error && err.message.startsWith("El método ")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
