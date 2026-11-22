// /api/admin/raffles — admin de rifas.
// GET ?status=&country=&page=&limit= — lista con filtros.
// POST — crea una rifa en BORRADOR (la moneda es la del país).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { getRaffleSalesSummary, RAFFLE_STATUSES } from "@/lib/raffles";
import { parseBody, raffleCreateSchema } from "@/lib/validate";
import type { RaffleStatus } from "@/generated/prisma/client";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "raffles.view");
    const params = req.nextUrl.searchParams;
    const statusParam = params.get("status");
    const countryParam = params.get("country")?.trim().toUpperCase();
    const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? "20") || 20));

    if (statusParam && !(RAFFLE_STATUSES as string[]).includes(statusParam)) {
      return NextResponse.json({ error: `Estado inválido: ${statusParam}` }, { status: 400 });
    }
    const where = {
      ...(statusParam ? { status: statusParam as RaffleStatus } : {}),
      ...(countryParam ? { country: { code: countryParam } } : {}),
    };
    const [total, raffles] = await Promise.all([
      db.raffle.count({ where }),
      db.raffle.findMany({
        where,
        include: { country: { select: { code: true, name: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const data = await Promise.all(
      raffles.map(async (r) => {
        const summary = await getRaffleSalesSummary(r);
        return {
          ...r,
          country: r.country.code,
          countryName: r.country.name,
          ...summary,
        };
      }),
    );
    return NextResponse.json({ data, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requirePermission(req, "raffles.create");
    const body = await parseBody(req, raffleCreateSchema);
    if (body.drawAt < new Date()) {
      return NextResponse.json(
        { error: "La fecha de sorteo no puede estar en el pasado" },
        { status: 400 },
      );
    }
    const country = await db.country.findUnique({ where: { id: body.countryId } });
    if (!country) return NextResponse.json({ error: "País no existe" }, { status: 404 });
    // Crear en BORRADOR se permite en cualquier país; publicar/programar
    // exige país ACTIVO (ver applyRaffleTransition, plan §2.9).
    const raffle = await db.raffle.create({
      data: {
        title: body.title,
        description: body.description,
        prize: body.prize,
        imageUrl: body.imageUrl ?? null,
        countryId: country.id,
        currency: country.currencyCode,
        ticketPrice: body.ticketPrice,
        totalTickets: body.totalTickets,
        drawAt: body.drawAt,
        rules: body.rules ?? "",
        licenseNumber: body.licenseNumber ?? null,
        minTicketsToDraw: body.minTicketsToDraw ?? null,
        maxTicketsPerPurchase: body.maxTicketsPerPurchase ?? null,
        maxTicketsPerCustomer: body.maxTicketsPerCustomer ?? null,
        status: "BORRADOR",
        createdById: user.id,
      },
    });
    await logAudit({
      actorId: user.id,
      action: "raffles.create",
      entity: "Raffle",
      entityId: raffle.id,
      after: { title: raffle.title, country: country.code, ticketPrice: raffle.ticketPrice, totalTickets: raffle.totalTickets },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: raffle }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
