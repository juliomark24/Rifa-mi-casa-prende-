// GET /api/draws/[raffleId]/commitment — público. Compromiso pre-sorteo
// (plan §2.5: se publica ANTES del sorteo). La semilla NUNCA se revela
// aquí: solo tras ejecutar el sorteo, en GET /api/draws/[raffleId] (S7).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ raffleId: string }> },
) {
  try {
    const { raffleId } = await params;
    const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
    if (!raffle) return NextResponse.json({ error: "Rifa no existe" }, { status: 404 });
    const draw = await db.draw.findUnique({ where: { raffleId } });
    if (!draw) {
      return NextResponse.json(
        { error: "El compromiso aún no se ha publicado para esta rifa" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      raffleId,
      commitment: draw.commitment,
      hashElegibles: draw.hashElegibles,
      totalElegibles: draw.totalElegibles,
      algorithm: draw.algorithm,
      publishedAt: draw.createdAt,
      executedAt: draw.executedAt,
      // La semilla se guarda en Draw.seed al publicar el compromiso (sin
      // ella no se podría verificar después), pero "revelada" significa
      // pública: solo tras ejecutar el sorteo. Nunca se devuelve aquí.
      seedRevealed: draw.executedAt !== null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
