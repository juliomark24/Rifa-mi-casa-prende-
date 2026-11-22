// POST /api/admin/countries/[id]/activate — gate de activación (P18).
// Solo activa si legalVerified=true Y providerVerified=true para ese país;
// si no pasa, 409 con los motivos exactos.
//
// NOTA (seed pre-lanzamiento): el seed dejó DO como ACTIVO con
// legalVerified=false/providerVerified=false. Este gate aplica a la
// TRANSICIÓN de activación; no revoca ni toca ese registro existente.
// Un país ya ACTIVO responde 200 (idempotente).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit, logChange } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { buildCountryProfile, checkActivationGate } from "@/lib/countries";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "countries.activate");
    const country = await db.country.findUnique({ where: { id } });
    if (!country) return NextResponse.json({ error: "País no existe" }, { status: 404 });
    if (country.status === "ACTIVO") {
      return NextResponse.json({ data: buildCountryProfile(country) });
    }

    const gate = checkActivationGate(country);
    if (!gate.ok) {
      return NextResponse.json(
        {
          error: "El país no pasa el gate de activación",
          reasons: gate.reasons,
        },
        { status: 409 },
      );
    }

    const updated = await db.$transaction(async (tx) => {
      const c = await tx.country.update({
        where: { id },
        data: { status: "ACTIVO" },
      });
      await tx.configHistory.create({
        data: {
          entity: "Country",
          entityId: id,
          changedById: user.id,
          before: { status: country.status },
          after: { status: "ACTIVO" },
          reason: "Activación por gate (legal + proveedor verificados)",
        },
      });
      return c;
    });
    await logChange({
      actorId: user.id,
      entity: "Country",
      entityId: id,
      field: "status",
      beforeValue: country.status,
      afterValue: "ACTIVO",
      reason: "Gate de activación superado",
    });
    await logAudit({
      actorId: user.id,
      action: "countries.activate",
      entity: "Country",
      entityId: id,
      before: { status: country.status },
      after: { status: "ACTIVO" },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: buildCountryProfile(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}
