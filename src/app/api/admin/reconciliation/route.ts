// GET /api/admin/reconciliation — lista de casos de conciliación (S5 los
// crea; S6 los expone). Permiso payments.view.
// Filtros: ?status=ABIERTO|EN_REVISION|RESUELTO, ?provider=, ?period= (YYYY-MM-DD).
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

const RECONCILIATION_STATUSES = ["ABIERTO", "EN_REVISION", "RESUELTO"] as const;

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "payments.view");
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const provider = url.searchParams.get("provider");
    const period = url.searchParams.get("period");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
    const where: Record<string, unknown> = {};
    if (status) {
      if (!(RECONCILIATION_STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: `status inválido: ${status}` }, { status: 400 });
      }
      where.status = status;
    }
    if (provider) where.provider = provider;
    if (period) where.period = period;
    const [cases, total, openCount, resolvedCount] = await Promise.all([
      db.reconciliationCase.findMany({
        where,
        include: { resolvedBy: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.reconciliationCase.count({ where }),
      db.reconciliationCase.count({ where: { ...where, status: "ABIERTO" } }),
      db.reconciliationCase.count({ where: { ...where, status: "RESUELTO" } }),
    ]);
    return NextResponse.json({ data: cases, page, total, open: openCount, resolved: resolvedCount });
  } catch (err) {
    return errorResponse(err);
  }
}
