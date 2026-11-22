// GET /api/admin/reports — ventas agrupadas (contrato v2.2, plan §2.6).
// S9-int: la ruta no existía aunque el contrato la define y el panel de
// Reportes la usa (?groupBy=day|raffle|country). Agregación en JS sobre
// pedidos (compatible SQLite/PostgreSQL, sin funciones de fecha del
// motor): ventas = suma de CONFIRMADO, reembolsos = suma de REEMBOLSADO,
// boletos = boletos VENDIDO de los pedidos confirmados del grupo.
// Respuesta de listas: {data, page, total}.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

const GROUP_BY = ["day", "raffle", "country"] as const;

type Row = {
  group: string;
  sales: number;
  orders: number;
  ticketsSold: number;
  refunds: number;
  currency: string;
};

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "reports.view");
    const groupBy = req.nextUrl.searchParams.get("groupBy") ?? "day";
    if (!(GROUP_BY as readonly string[]).includes(groupBy)) {
      return NextResponse.json({ error: `groupBy inválido: ${groupBy} (day|raffle|country)` }, { status: 400 });
    }
    const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "20") || 20));

    const orders = await db.order.findMany({
      where: { status: { in: ["CONFIRMADO", "REEMBOLSADO", "DISPUTADO"] } },
      include: {
        raffle: { select: { id: true, title: true, country: { select: { code: true } } } },
        _count: { select: { tickets: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    // Boletos VENDIDO por pedido (para ticketsSold del grupo).
    const soldCounts = orders.length
      ? await db.ticket.groupBy({
          by: ["orderId"],
          where: { orderId: { in: orders.map((o) => o.id) }, status: "VENDIDO" },
          _count: { _all: true },
        })
      : [];
    const soldByOrder = new Map(soldCounts.map((c) => [c.orderId as string, c._count._all]));

// S10 (P27, plan §2.9/§5.1): la clave de agrupación incluye la moneda.
// Sin esto, un reporte global sumaba pedidos DOP y USD en una misma fila
// etiquetada con la moneda del primer pedido — un recálculo implícito que
// reescribía el valor original. Con una sola moneda activa (Fase 1: DO/DOP)
// el comportamiento no cambia; con varias, cada moneda tiene su fila.
    const byGroup = new Map<string, Row>();
    for (const o of orders) {
      const baseKey =
        groupBy === "day"
          ? o.createdAt.toISOString().slice(0, 10)
          : groupBy === "raffle"
            ? o.raffle.title
            : (o.raffle.country?.code ?? "—");
      const key = `${baseKey}||${o.currency}`;
      const row = byGroup.get(key) ?? {
        group: baseKey,
        sales: 0,
        orders: 0,
        ticketsSold: 0,
        refunds: 0,
        currency: o.currency,
      };
      if (o.status === "CONFIRMADO" || o.status === "DISPUTADO") {
        row.sales += o.totalAmount;
        row.orders += 1;
        row.ticketsSold += soldByOrder.get(o.id) ?? 0;
      }
      if (o.status === "REEMBOLSADO") row.refunds += o.totalAmount;
      byGroup.set(key, row);
    }
    const all = [...byGroup.values()].sort((a, b) => (a.group < b.group ? -1 : 1));
    const total = all.length;
    const data = all.slice((page - 1) * limit, page * limit);
    return NextResponse.json({ data, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}
