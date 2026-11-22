// GET /api/admin/affiliates — lista de afiliados con resumen (ventas,
// comisiones por estado, saldo, retiros, riesgo). Permiso affiliates.view.
// Filtros: ?riskStatus=NORMAL|REVISION|RETENIDO|BLOQUEADO, ?search= (email/nombre/código).
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getAffiliateSummary } from "@/lib/affiliates";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "affiliates.view");
    const url = new URL(req.url);
    const riskStatus = url.searchParams.get("riskStatus");
    const search = url.searchParams.get("search")?.trim();
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
    const where: Record<string, unknown> = { role: "AFILIADO" };
    if (search) {
      where.OR = [
        { email: { contains: search } },
        { name: { contains: search } },
        { referralCode: { contains: search } },
      ];
    }
    const [affiliates, total] = await Promise.all([
      db.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true },
      }),
      db.user.count({ where }),
    ]);
    const data = [];
    for (const a of affiliates) {
      const summary = await getAffiliateSummary(db, a.id);
      if (!summary) continue;
      if (riskStatus && summary.riskStatus !== riskStatus) continue;
      data.push(summary);
    }
    return NextResponse.json({ data, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
