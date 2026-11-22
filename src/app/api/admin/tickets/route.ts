// GET /api/admin/tickets — lista de boletos (permiso tickets.view).
// Filtros: ?raffleId= &status=, paginación ?page=&limit=.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { presentTicket } from "@/lib/tickets";

const TICKET_STATUSES = ["DISPONIBLE", "RESERVADO", "VENDIDO", "ANULADO", "BLOCKED"] as const;

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "tickets.view");
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const raffleId = url.searchParams.get("raffleId");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
    const where: Record<string, unknown> = {};
    if (status) {
      if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: `status inválido: ${status}` }, { status: 400 });
      }
      where.status = status;
    }
    if (raffleId) where.raffleId = raffleId;
    const [tickets, total] = await Promise.all([
      db.ticket.findMany({
        where,
        orderBy: [{ raffleId: "asc" }, { number: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.ticket.count({ where }),
    ]);
    return NextResponse.json({ data: tickets.map(presentTicket), page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
