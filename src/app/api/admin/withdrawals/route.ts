// GET /api/admin/withdrawals — lista de retiros (permiso withdrawals.view).
// Filtros: ?status=REQUESTED|APPROVED|PAID|REJECTED, ?affiliateId=.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { presentWithdrawal } from "@/lib/affiliates";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

const WITHDRAWAL_STATUSES = ["REQUESTED", "APPROVED", "PAID", "REJECTED"] as const;

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "withdrawals.view");
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const affiliateId = url.searchParams.get("affiliateId");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
    const where: Record<string, unknown> = {};
    if (status) {
      if (!(WITHDRAWAL_STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: `status inválido: ${status}` }, { status: 400 });
      }
      where.status = status;
    }
    if (affiliateId) where.affiliateId = affiliateId;
    const [withdrawals, total] = await Promise.all([
      db.withdrawal.findMany({
        where,
        include: { affiliate: { select: { id: true, name: true, email: true, referralCode: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.withdrawal.count({ where }),
    ]);
    return NextResponse.json({
      data: withdrawals.map((w) => ({ ...presentWithdrawal(w), affiliate: w.affiliate })),
      page,
      total,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
