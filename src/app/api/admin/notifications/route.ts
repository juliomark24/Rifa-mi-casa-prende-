// GET /api/admin/notifications — cola, entregas y fallidos (plan §2.16).
// Filtros: ?status=PENDIENTE|ENVIADO|ENTREGADO|FALLIDO
//          &channel=EMAIL|WHATSAPP|SMS|WEB &event=pago_confirmado...
//          &page=&limit= — respuesta de lista estándar del contrato.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse } from "@/lib/errors";

const STATUSES = ["PENDIENTE", "ENVIADO", "ENTREGADO", "FALLIDO"] as const;
const CHANNELS = ["EMAIL", "WHATSAPP", "SMS", "WEB"] as const;

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "notifications.view");
    const search = req.nextUrl.searchParams;
    const status = search.get("status");
    const channel = search.get("channel");
    const event = search.get("event");
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`status inválido: ${status}`);
    }
    if (channel && !(CHANNELS as readonly string[]).includes(channel)) {
      throw badRequest(`channel inválido: ${channel}`);
    }
    const page = Math.max(1, Number(search.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(search.get("limit") ?? "20") || 20));
    const where: { status?: (typeof STATUSES)[number]; channel?: (typeof CHANNELS)[number]; event?: string } = {};
    if (status) where.status = status as (typeof STATUSES)[number];
    if (channel) where.channel = channel as (typeof CHANNELS)[number];
    if (event) where.event = event;
    const [total, rows] = await Promise.all([
      db.notification.count({ where }),
      db.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return NextResponse.json({ data: rows, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
