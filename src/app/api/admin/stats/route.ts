// GET /api/admin/stats — dashboard financiero y comercial (contrato v2.2,
// plan §2.6). S9-int: la ruta no existía aunque el contrato la define y
// el panel admin la usa. Devuelve los campos del contrato (salesGross,
// salesConfirmed, pendingOrders, refunds, chargebacks, comisiones,
// profitEstimated, alerts) MÁS los que lee el dashboard (totalSales,
// totalRevenue, totalOrders, totalRaffles, totalAffiliates, percentSold,
// conversionRate, salesRate). Dinero en enteros. Las alertas se calculan
// con checkAlerts (S8, §2.19): ritmo lento, pagos pendientes > 24 h, etc.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { checkAlerts } from "@/lib/monitoring";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "reports.view");
    const [
      orders,
      ticketsSold,
      ticketsTotal,
      affiliates,
      raffles,
      commissions,
      clicks,
      recentTickets,
    ] = await Promise.all([
      db.order.findMany({ select: { status: true, totalAmount: true, createdAt: true } }),
      db.ticket.count({ where: { status: "VENDIDO" } }),
      db.ticket.count(),
      db.user.count({ where: { role: "AFILIADO" } }),
      db.raffle.count(),
      db.commission.findMany({ select: { status: true, amount: true } }),
      db.click.count(),
      db.ticket.count({
        where: { status: "VENDIDO", updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      }),
    ]);

    const sum = (status: string) =>
      orders.filter((o) => o.status === status).reduce((acc, o) => acc + o.totalAmount, 0);
    const count = (status: string) => orders.filter((o) => o.status === status).length;
    const salesConfirmed = sum("CONFIRMADO") + sum("DISPUTADO");
    const salesGross = salesConfirmed + sum("REEMBOLSADO");
    const refundsAmount = sum("REEMBOLSADO");
    const chargebacksAmount = sum("DISPUTADO");
    const commissionsGenerated = commissions.reduce((acc, c) => acc + c.amount, 0);
    const commissionsRetained = commissions
      .filter((c) => c.status === "RETAINED")
      .reduce((acc, c) => acc + c.amount, 0);
    const commissionsPaid = commissions
      .filter((c) => c.status === "PAID")
      .reduce((acc, c) => acc + c.amount, 0);
    const costos = await db.ledgerEntry.aggregate({
      where: { type: "COSTO" },
      _sum: { amount: true },
    });
    const profitEstimated =
      salesConfirmed - refundsAmount - chargebacksAmount - commissionsGenerated + (costos._sum.amount ?? 0);

    const confirmedOrders = count("CONFIRMADO") + count("DISPUTADO");
    const alerts = await checkAlerts();

    return NextResponse.json({
      // Contrato v2.2.
      salesGross,
      salesConfirmed,
      pendingOrders: count("PENDIENTE"),
      refunds: count("REEMBOLSADO"),
      refundsAmount,
      chargebacks: count("DISPUTADO"),
      chargebacksAmount,
      commissionsGenerated,
      commissionsRetained,
      commissionsPaid,
      profitEstimated,
      alerts: alerts.map((a) => ({ type: a.type, severity: a.severity, message: a.message })),
      // Campos que lee el dashboard.
      totalSales: ticketsSold,
      totalRevenue: salesConfirmed,
      totalOrders: orders.length,
      totalRaffles: raffles,
      totalTicketsSold: ticketsSold,
      percentSold: ticketsTotal > 0 ? Math.round((ticketsSold / ticketsTotal) * 100) : 0,
      totalAffiliates: affiliates,
      profit: profitEstimated,
      conversionRate: clicks > 0 ? confirmedOrders / clicks : 0,
      salesRate: recentTickets,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
