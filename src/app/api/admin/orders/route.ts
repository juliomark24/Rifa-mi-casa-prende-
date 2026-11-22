// GET /api/admin/orders — lista de pedidos (permiso orders.view).
// Filtros: ?status= &raffleId= &buyerEmail=, paginación ?page=&limit=.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { presentOrder } from "@/lib/orders";

const ORDER_STATUSES = ["PENDIENTE", "CONFIRMADO", "FALLIDO", "EXPIRADO", "REEMBOLSADO", "DISPUTADO"] as const;

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "orders.view");
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const raffleId = url.searchParams.get("raffleId");
    const buyerEmail = url.searchParams.get("buyerEmail");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
    const where: Record<string, unknown> = {};
    if (status) {
      if (!(ORDER_STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: `status inválido: ${status}` }, { status: 400 });
      }
      where.status = status;
    }
    if (raffleId) where.raffleId = raffleId;
    if (buyerEmail) where.buyerEmail = buyerEmail.trim().toLowerCase();
    const [orders, total] = await Promise.all([
      db.order.findMany({
        where,
        include: { tickets: { orderBy: { number: "asc" } }, payments: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.order.count({ where }),
    ]);
    return NextResponse.json({ data: orders.map(presentOrder), page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
