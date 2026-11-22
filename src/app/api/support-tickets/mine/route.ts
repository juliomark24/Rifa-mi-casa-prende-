// GET /api/support-tickets/mine — tickets del usuario autenticado:
// los creados con su cuenta, los de sus pedidos o los de su email.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireAuth(req);
    const search = req.nextUrl.searchParams;
    const page = Math.max(1, Number(search.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(search.get("limit") ?? "20") || 20));
    const myOrderIds = (
      await db.order.findMany({ where: { userId: user.id }, select: { id: true } })
    ).map((o) => o.id);
    const where = {
      OR: [{ userId: user.id }, { buyerEmail: user.email }, { orderId: { in: myOrderIds } }],
    };
    const [total, tickets] = await Promise.all([
      db.supportTicket.count({ where }),
      db.supportTicket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return NextResponse.json({ data: tickets, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
