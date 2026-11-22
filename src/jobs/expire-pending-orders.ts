// Job `expire-pending-orders` (plan §2.11, §2.12; decisión S5).
// Política de expiración de pedidos PENDIENTE de transferencia manual
// (la decisión que S4 dejó pendiente): el comprador tiene 24 h desde la
// creación para transferir; a las 20 h recibe un aviso por correo
// (evento `pedido_por_vencer`); a las 24 h el pedido expira.
//
// Al expirar: Order PENDIENTE → EXPIRADO, boletos RESERVADO →
// DISPONIBLE (vuelven a la venta), Payment PENDIENTE → FALLIDO y
// reservas CONFIRMADA → CANCELADA. Es la misma convención de
// `cancelOrder` de S4 (PaymentStatus no tiene EXPIRADO; ver nota en
// src/lib/payments/operations.ts).
//
// NO toca el job de reservas de S4 (`release-expired-reservations`):
// ese libera reservas temporales de ~10 min; este expira pedidos ya
// creados (con pago pendiente de verificación manual).
//
// Idempotente: el aviso usa dedupeKey por pedido (una sola vez) y la
// expiración solo encuentra pedidos todavía PENDIENTE; una segunda
// pasada no encuentra nada que expirar.
import { db } from "../lib/db";
import { logAudit } from "../lib/audit";
import { queueNotificationSafe } from "../lib/notifications";
import type { Tx } from "../lib/db";

export const JOB_NAME = "expire-pending-orders";

/** Horas desde la creación hasta el aviso al comprador. */
export const PENDING_ORDER_WARNING_HOURS = 20;
/** Horas desde la creación hasta expirar el pedido PENDIENTE. */
export const PENDING_ORDER_TTL_HOURS = 24;

export type ExpirePendingOrdersResult = {
  ok: boolean;
  warned: number;
  expired: number;
  warnedOrderCodes: string[];
  expiredOrderCodes: string[];
};

export async function run(now = new Date()): Promise<ExpirePendingOrdersResult> {
  const warnCutoff = new Date(now.getTime() - PENDING_ORDER_WARNING_HOURS * 60 * 60 * 1000);
  const expireCutoff = new Date(now.getTime() - PENDING_ORDER_TTL_HOURS * 60 * 60 * 1000);

  // Aviso a las 20 h: PENDIENTE, creado hace ≥20 h y <24 h (aún no expira).
  // Idempotente: se revisa qué pedidos ya fueron avisados (dedupeKey) y
  // solo se cuentan los avisos nuevos de esta pasada.
  const alreadyWarnedRows = await db.notification.findMany({
    where: { event: "pedido_por_vencer" },
    select: { payload: true },
  });
  const warnedKeys = new Set(
    alreadyWarnedRows.map((n) => (n.payload as { dedupeKey?: string } | null)?.dedupeKey),
  );
  const toWarn = await db.order.findMany({
    where: {
      status: "PENDIENTE",
      createdAt: { lte: warnCutoff, gt: expireCutoff },
    },
    orderBy: { createdAt: "asc" },
  });
  const warnedOrderCodes: string[] = [];
  for (const order of toWarn) {
    if (warnedKeys.has(`pedido-por-vencer:${order.id}`)) continue;
    const queued = await queueNotificationSafe({
      event: "pedido_por_vencer",
      channel: "EMAIL",
      recipient: order.buyerEmail,
      data: {
        buyerName: order.buyerName,
        orderCode: order.code,
        totalAmount: order.totalAmount,
        currency: order.currency,
      },
      dedupeKey: `pedido-por-vencer:${order.id}`,
    });
    if (queued) warnedOrderCodes.push(order.code);
  }

  // Expiración a las 24 h: PENDIENTE creado hace ≥24 h.
  const toExpire = await db.order.findMany({
    where: { status: "PENDIENTE", createdAt: { lte: expireCutoff } },
    include: { tickets: true },
    orderBy: { createdAt: "asc" },
  });
  const expiredOrderCodes: string[] = [];
  for (const order of toExpire) {
    const reservationIds = [
      ...new Set(order.tickets.map((t) => t.reservationId).filter((x): x is string => Boolean(x))),
    ];
    await db.$transaction(async (tx: Tx) => {
      const fresh = await tx.order.findUnique({ where: { id: order.id } });
      if (!fresh || fresh.status !== "PENDIENTE") return;
      await tx.order.update({ where: { id: order.id }, data: { status: "EXPIRADO" } });
      await tx.ticket.updateMany({
        where: { orderId: order.id, status: "RESERVADO" },
        data: { status: "DISPONIBLE", orderId: null, reservationId: null },
      });
      await tx.payment.updateMany({
        where: { orderId: order.id, status: "PENDIENTE" },
        data: { status: "FALLIDO" },
      });
      for (const rid of reservationIds) {
        await tx.reservation.updateMany({
          where: { id: rid, status: "CONFIRMADA" },
          data: { status: "CANCELADA" },
        });
      }
    });
    const after = await db.order.findUnique({ where: { id: order.id } });
    if (after?.status === "EXPIRADO") {
      expiredOrderCodes.push(order.code);
      await logAudit({
        actorId: null,
        action: "orders.expire",
        entity: "Order",
        entityId: order.id,
        before: { status: "PENDIENTE", tickets: order.tickets.map((t) => t.number) },
        after: { status: "EXPIRADO", reason: `sin confirmación de pago en ${PENDING_ORDER_TTL_HOURS} h`, job: JOB_NAME },
      });
    }
  }

  return {
    ok: true,
    warned: warnedOrderCodes.length,
    expired: expiredOrderCodes.length,
    warnedOrderCodes,
    expiredOrderCodes,
  };
}
