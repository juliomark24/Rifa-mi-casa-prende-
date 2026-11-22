// GET /api/orders/mine — historial de compras del usuario autenticado
// (por su cuenta o por su email: cubre compras invitadas del mismo email).
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { listOrdersForBuyer } from "@/lib/orders";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireAuth(req);
    const url = new URL(req.url);
    const page = Number(url.searchParams.get("page") ?? "1") || 1;
    const limit = Number(url.searchParams.get("limit") ?? "20") || 20;
    const result = await listOrdersForBuyer({ userId: user.id, buyerEmail: user.email, page, limit });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
