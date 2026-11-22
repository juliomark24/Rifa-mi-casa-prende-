// GET /api/affiliates/me/sales — ventas atribuidas al afiliado (ventana
// de 7 días, último clic; la atribución ya quedó guardada en la orden en
// S4). Solo sus propias ventas. Paginación ?page=&limit=.
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireRole(req, ["AFILIADO"]);
    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
    const where = { affiliateId: user.id };
    const [orders, total] = await Promise.all([
      db.order.findMany({
        where,
        include: {
          tickets: { select: { id: true, number: true } },
          commissions: { select: { id: true, amount: true, status: true } },
          raffle: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.order.count({ where }),
    ]);
    const data = orders.map((o) => ({
      id: o.id,
      code: o.code,
      raffleId: o.raffleId,
      raffleTitle: o.raffle.title,
      buyerEmail: o.buyerEmail,
      totalAmount: o.totalAmount,
      currency: o.currency,
      status: o.status,
      tickets: o.tickets.length,
      ticketNumbers: o.tickets.map((t) => t.number),
      commission: o.commissions[0]
        ? { id: o.commissions[0].id, amount: o.commissions[0].amount, status: o.commissions[0].status }
        : null,
      createdAt: o.createdAt,
    }));
    return NextResponse.json({ data, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
