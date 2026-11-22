// GET /api/raffles/[id] — público. Detalle + números vendidos y reservados
// (para el selector), versión vigente de las bases y licencia.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const raffle = await db.raffle.findUnique({
      where: { id },
      include: { country: { select: { code: true, name: true } } },
    });
    if (!raffle) return NextResponse.json({ error: "Rifa no existe" }, { status: 404 });
    const tickets = await db.ticket.findMany({
      where: { raffleId: id, status: { in: ["VENDIDO", "RESERVADO"] } },
      select: { number: true, status: true },
    });
    const soldNumbers = tickets.filter((t) => t.status === "VENDIDO").map((t) => t.number);
    const reservedNumbers = tickets.filter((t) => t.status === "RESERVADO").map((t) => t.number);
    const terms = raffle.termsVersionId
      ? await db.raffleTerms.findUnique({ where: { id: raffle.termsVersionId } })
      : null;
    return NextResponse.json({
      id: raffle.id,
      title: raffle.title,
      description: raffle.description,
      prize: raffle.prize,
      imageUrl: raffle.imageUrl,
      country: raffle.country.code,
      countryName: raffle.country.name,
      currency: raffle.currency,
      ticketPrice: raffle.ticketPrice,
      totalTickets: raffle.totalTickets,
      drawAt: raffle.drawAt,
      status: raffle.status,
      rules: raffle.rules,
      termsVersionId: raffle.termsVersionId,
      termsVersion: terms ? { version: terms.version, content: terms.content } : null,
      licenseNumber: raffle.licenseNumber,
      soldCount: soldNumbers.length,
      soldNumbers,
      reservedNumbers,
      availableCount: raffle.totalTickets - soldNumbers.length - reservedNumbers.length,
      percentSold: Math.round((soldNumbers.length / raffle.totalTickets) * 100),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
