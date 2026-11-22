// GET /api/admin/winners — casos de ganadores (plan §2.15).
// Filtros: ?status= (uno de los 7 estados) y ?raffleId=. Paginación
// ?page=&limit= (defecto 20, máx 100). Incluye título de rifa y datos del
// boleto ganador (solo admin; en público solo se publica el número).
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { isWinnerCaseStatus } from "@/lib/winner";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "winners.view");
    const statusParam = req.nextUrl.searchParams.get("status");
    const raffleId = req.nextUrl.searchParams.get("raffleId");
    if (statusParam && !isWinnerCaseStatus(statusParam)) {
      return NextResponse.json({ error: "Estado de caso inválido" }, { status: 400 });
    }
    const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "20") || 20));
    const where = {
      ...(statusParam ? { status: statusParam as "PENDIENTE_CONTACTO" } : {}),
      ...(raffleId ? { raffleId } : {}),
    };
    const [total, cases] = await Promise.all([
      db.winnerCase.count({ where }),
      db.winnerCase.findMany({
        where,
        include: {
          raffle: { select: { id: true, title: true, prize: true, status: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    // Datos del boleto ganador (número, código, comprador) por caso.
    const ticketIds = cases.map((c) => c.winningTicketId).filter((x): x is string => Boolean(x));
    const tickets = ticketIds.length
      ? await db.ticket.findMany({
          where: { id: { in: ticketIds } },
          select: { id: true, number: true, code: true, buyerName: true, buyerEmail: true },
        })
      : [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const data = cases.map((c) => {
      const ticket = c.winningTicketId ? byId.get(c.winningTicketId) : undefined;
      return {
        id: c.id,
        raffleId: c.raffleId,
        raffleTitle: c.raffle.title,
        rafflePrize: c.raffle.prize,
        raffleStatus: c.raffle.status,
        winningTicketId: c.winningTicketId,
        ticketNumber: ticket?.number ?? null,
        ticketCode: ticket?.code ?? null,
        buyerName: ticket?.buyerName ?? null,
        buyerEmail: ticket?.buyerEmail ?? null,
        status: c.status,
        evidence: c.evidence,
        contactLog: c.contactLog,
        notes: c.notes,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
    return NextResponse.json({ data, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
