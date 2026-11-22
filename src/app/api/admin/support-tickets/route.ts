// GET /api/admin/support-tickets — lista de tickets con filtros
// (plan §2.17, contrato). Filtros: ?status=&type=&page=&limit=.
// Cada ticket incluye su contexto (pedido enlazado + responsable) y
// su plazo de resolución (dueAt según prioridad, ver §2.17).
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse } from "@/lib/errors";
import { supportTicketDueAt, SUPPORT_SLA_HOURS } from "@/lib/monitoring";

const STATUSES = ["ABIERTO", "EN_REVISION", "ESPERANDO_CLIENTE", "RESUELTO", "CERRADO"] as const;
const TYPES = [
  "PAGO_SIN_BOLETO",
  "CONSULTA_BOLETO",
  "PAGO_RECHAZADO",
  "PROBLEMA_COMPRA",
  "DEVOLUCION",
  "DUDA_GANADOR",
  "OTRO",
] as const;

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "support.view");
    const search = req.nextUrl.searchParams;
    const status = search.get("status");
    const type = search.get("type");
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`status inválido: ${status}`);
    }
    if (type && !(TYPES as readonly string[]).includes(type)) {
      throw badRequest(`type inválido: ${type}`);
    }
    const page = Math.max(1, Number(search.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(search.get("limit") ?? "20") || 20));
    const where: { status?: (typeof STATUSES)[number]; type?: (typeof TYPES)[number] } = {};
    if (status) where.status = status as (typeof STATUSES)[number];
    if (type) where.type = type as (typeof TYPES)[number];
    const [total, tickets] = await Promise.all([
      db.supportTicket.count({ where }),
      db.supportTicket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          owner: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);
    // SupportTicket guarda orderId sin relación Prisma: el pedido se
    // resuelve aparte para el contexto (§2.17).
    const orderIds = tickets.map((t) => t.orderId).filter((id): id is string => id !== null);
    const orders = orderIds.length
      ? await db.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, code: true, status: true, totalAmount: true, currency: true, buyerEmail: true },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const data = tickets.map((t) => ({
      ...t,
      order: t.orderId ? (orderById.get(t.orderId) ?? null) : null,
      slaHours: SUPPORT_SLA_HOURS[t.priority],
      dueAt: supportTicketDueAt(t).toISOString(),
    }));
    return NextResponse.json({ data, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
