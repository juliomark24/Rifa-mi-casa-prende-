// GET /api/raffles — lista pública de rifas.
// ?status= (uno de los 11 estados) &country= (código ISO) &page= &limit=
// Sin ?status=, solo rifas publicadas (se excluyen BORRADOR,
// PENDIENTE_APROBACION y CANCELADA): el catálogo no muestra borradores.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { RAFFLE_PUBLIC_STATUSES, RAFFLE_STATUSES } from "@/lib/raffles";
import type { RaffleStatus } from "@/generated/prisma/client";

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const statusParam = params.get("status");
    const countryParam = params.get("country")?.trim().toUpperCase();
    const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? "20") || 20));

    let statusFilter: RaffleStatus[] | undefined;
    if (statusParam) {
      if (!(RAFFLE_STATUSES as string[]).includes(statusParam)) {
        return NextResponse.json({ error: `Estado inválido: ${statusParam}` }, { status: 400 });
      }
      statusFilter = [statusParam as RaffleStatus];
    } else {
      statusFilter = RAFFLE_PUBLIC_STATUSES;
    }

    const where = {
      status: { in: statusFilter },
      ...(countryParam ? { country: { code: countryParam } } : {}),
    };
    const [total, raffles] = await Promise.all([
      db.raffle.count({ where }),
      db.raffle.findMany({
        where,
        include: { country: { select: { code: true, name: true } } },
        orderBy: { drawAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // Conteos de ventas por rifa (una sola consulta por estado).
    const ids = raffles.map((r) => r.id);
    const counts = ids.length
      ? await db.ticket.groupBy({
          by: ["raffleId", "status"],
          where: { raffleId: { in: ids }, status: { in: ["VENDIDO", "RESERVADO"] } },
          _count: { _all: true },
        })
      : [];
    const soldByRaffle = new Map<string, number>();
    const reservedByRaffle = new Map<string, number>();
    for (const c of counts) {
      const target = c.status === "VENDIDO" ? soldByRaffle : reservedByRaffle;
      target.set(c.raffleId, c._count._all);
    }

    const data = raffles.map((r) => {
      const soldCount = soldByRaffle.get(r.id) ?? 0;
      const reservedCount = reservedByRaffle.get(r.id) ?? 0;
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        prize: r.prize,
        imageUrl: r.imageUrl,
        country: r.country.code,
        countryName: r.country.name,
        currency: r.currency,
        ticketPrice: r.ticketPrice,
        totalTickets: r.totalTickets,
        drawAt: r.drawAt,
        status: r.status,
        rules: r.rules,
        termsVersionId: r.termsVersionId,
        licenseNumber: r.licenseNumber,
        soldCount,
        percentSold: r.totalTickets > 0 ? Math.round((soldCount / r.totalTickets) * 100) : 0,
        availableCount: Math.max(0, r.totalTickets - soldCount - reservedCount),
      };
    });
    return NextResponse.json({ data, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
