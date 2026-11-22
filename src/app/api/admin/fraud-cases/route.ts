// GET /api/admin/fraud-cases — lista de casos de fraude (permiso fraud.view).
// Filtros: ?status=NORMAL|REVISION|RETENIDO|APROBADO|BLOQUEADO, ?rule=, ?entityType=, ?entityId=.
//
// POST /api/admin/fraud-cases — marca manual para revisión (permiso fraud.review).
// Cuerpo: {rule, reason, entityType, entityId}. Idempotente: si ya hay un
// caso abierto con misma regla+entidad, devuelve ese caso sin duplicar.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { flagForReview } from "@/lib/fraud";
import { parseBody } from "@/lib/validate";

const RISK_STATUSES = ["NORMAL", "REVISION", "RETENIDO", "APROBADO", "BLOQUEADO"] as const;

const fraudCreateSchema = z.object({
  rule: z.string().trim().min(1, "La regla es obligatoria").max(100),
  reason: z.string().trim().min(1, "El motivo es obligatorio").max(2000),
  entityType: z.string().trim().min(1).max(50),
  entityId: z.string().trim().min(1).max(200),
});

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "fraud.view");
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const rule = url.searchParams.get("rule");
    const entityType = url.searchParams.get("entityType");
    const entityId = url.searchParams.get("entityId");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
    const where: Record<string, unknown> = {};
    if (status) {
      if (!(RISK_STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: `status inválido: ${status}` }, { status: 400 });
      }
      where.status = status;
    }
    if (rule) where.rule = rule;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    const [cases, total] = await Promise.all([
      db.fraudCase.findMany({
        where,
        include: { reviewedBy: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.fraudCase.count({ where }),
    ]);
    return NextResponse.json({ data: cases, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requirePermission(req, "fraud.review");
    const body = await parseBody(req, fraudCreateSchema);
    const { fraudCase, created } = await flagForReview(db, {
      rule: body.rule,
      reason: body.reason,
      entityType: body.entityType,
      entityId: body.entityId,
      actorId: user.id,
    });
    return NextResponse.json({ data: fraudCase, created }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
