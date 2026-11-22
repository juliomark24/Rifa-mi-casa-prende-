// GET /api/admin/support-tickets/stats — métricas de soporte (§2.17):
// tickets abiertos, tiempo medio de resolución, reclamaciones por tipo.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getSupportStats } from "@/lib/monitoring";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "support.view");
    const stats = await getSupportStats();
    return NextResponse.json(stats);
  } catch (err) {
    return errorResponse(err);
  }
}
