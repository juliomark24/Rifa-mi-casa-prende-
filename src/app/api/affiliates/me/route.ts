// GET /api/affiliates/me — perfil del afiliado: resumen de clics, ventas,
// comisiones por estado, saldo (incl. saldo negativo) y riesgo.
// Rol AFILIADO (el rol nunca viene del cliente).
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getAffiliateSummary } from "@/lib/affiliates";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireRole(req, ["AFILIADO"]);
    const summary = await getAffiliateSummary(db, user.id);
    if (!summary) return NextResponse.json({ error: "Afiliado no existe" }, { status: 404 });
    return NextResponse.json(summary);
  } catch (err) {
    return errorResponse(err);
  }
}
