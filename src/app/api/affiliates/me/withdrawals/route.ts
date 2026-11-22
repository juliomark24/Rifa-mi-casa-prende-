// GET /api/affiliates/me/withdrawals — historial de retiros del afiliado.
// Solo sus propios retiros. Paginación ?page=&limit=, filtro ?status=.
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { presentWithdrawal } from "@/lib/affiliates";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

const WITHDRAWAL_STATUSES = ["REQUESTED", "APPROVED", "PAID", "REJECTED"] as const;

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireRole(req, ["AFILIADO"]);
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
    const where: Record<string, unknown> = { affiliateId: user.id };
    if (status) {
      if (!(WITHDRAWAL_STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: `status inválido: ${status}` }, { status: 400 });
      }
      where.status = status;
    }
    const [withdrawals, total] = await Promise.all([
      db.withdrawal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.withdrawal.count({ where }),
    ]);
    return NextResponse.json({ data: withdrawals.map(presentWithdrawal), page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
