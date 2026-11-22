// Boletos: disponibilidad real, bloqueo/desbloqueo y anulación con motivo
// (plan §2.1). El servidor es la única autoridad de disponibilidad; el
// navegador nunca decide. Anular un boleto pagado registra la necesidad
// de reembolso (el flujo de reembolso es S5/S6).
import { z } from "zod";
import { db } from "./db";
import { logAudit } from "./audit";
import { ApiError, conflict, notFound } from "./errors";
import { availableNumbers } from "./reservations";

export const annulSchema = z.object({
  reason: z.string().trim().min(5, "El motivo de la anulación es obligatorio").max(2000),
});

export type Availability = {
  raffleId: string;
  totalTickets: number;
  available: number[];
  reserved: number[];
  sold: number[];
  blocked: number[];
  annulled: number[];
  availableCount: number;
  reservedCount: number;
  soldCount: number;
};

export async function getAvailability(raffleId: string): Promise<Availability> {
  const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle) throw notFound("Rifa no existe");
  const tickets = await db.ticket.findMany({
    where: { raffleId },
    select: { number: true, status: true },
  });
  const byStatus = new Map<string, number[]>();
  for (const t of tickets) {
    const list = byStatus.get(t.status) ?? [];
    list.push(t.number);
    byStatus.set(t.status, list);
  }
  const taken = new Set<number>();
  for (const [status, nums] of byStatus) {
    if (status === "DISPONIBLE" || status === "ANULADO") continue;
    for (const n of nums) taken.add(n);
  }
  const available: number[] = [];
  for (let n = 1; n <= raffle.totalTickets; n++) {
    if (!taken.has(n)) available.push(n);
  }
  const sort = (a: number[]) => a.sort((x, y) => x - y);
  return {
    raffleId,
    totalTickets: raffle.totalTickets,
    available,
    reserved: sort(byStatus.get("RESERVADO") ?? []),
    sold: sort(byStatus.get("VENDIDO") ?? []),
    blocked: sort(byStatus.get("BLOCKED") ?? []),
    annulled: sort(byStatus.get("ANULADO") ?? []),
    availableCount: available.length,
    reservedCount: (byStatus.get("RESERVADO") ?? []).length,
    soldCount: (byStatus.get("VENDIDO") ?? []).length,
  };
}

/** Números cercanos disponibles a uno dado (para el 409 de reserva). */
export async function suggestNearbyNumbers(
  raffleId: string,
  wanted: number,
  count = 3,
): Promise<number[]> {
  const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle) return [];
  const available = await availableNumbers(db, raffle);
  const set = new Set(available);
  const out: number[] = [];
  for (let d = 1; d <= Math.max(wanted, raffle.totalTickets) && out.length < count; d++) {
    if (set.has(wanted + d)) out.push(wanted + d);
    if (out.length >= count) break;
    if (set.has(wanted - d)) out.push(wanted - d);
  }
  return out;
}

export type TicketView = {
  id: string;
  number: number;
  code: string;
  status: string;
  raffleId: string;
  orderId: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  buyerPhone: string | null;
  createdAt: Date;
};

export function presentTicket(t: {
  id: string;
  number: number;
  code: string;
  status: string;
  raffleId: string;
  orderId: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  buyerPhone: string | null;
  createdAt: Date;
}): TicketView {
  return {
    id: t.id,
    number: t.number,
    code: t.code,
    status: t.status,
    raffleId: t.raffleId,
    orderId: t.orderId,
    buyerName: t.buyerName,
    buyerEmail: t.buyerEmail,
    buyerPhone: t.buyerPhone,
    createdAt: t.createdAt,
  };
}

/** Bloquea un boleto DISPONIBLE (no se vende mientras tanto). */
export async function blockTicket(
  ticketId: string,
  actorId: string,
  reason?: string,
) {
  const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw notFound("Boleto no existe");
  if (ticket.status !== "DISPONIBLE") {
    throw conflict(
      `Solo se puede bloquear un boleto DISPONIBLE (actual: ${ticket.status})`,
      "TICKET_NOT_BLOCKABLE",
    );
  }
  const updated = await db.ticket.update({
    where: { id: ticketId },
    data: { status: "BLOCKED" },
  });
  await logAudit({
    actorId,
    action: "tickets.block",
    entity: "Ticket",
    entityId: ticketId,
    before: { status: ticket.status },
    after: { status: "BLOCKED", reason: reason ?? null },
  });
  return presentTicket(updated);
}

/** Desbloquea un boleto BLOCKED → DISPONIBLE. */
export async function unblockTicket(ticketId: string, actorId: string) {
  const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw notFound("Boleto no existe");
  if (ticket.status !== "BLOCKED") {
    throw conflict(
      `Solo se puede desbloquear un boleto BLOCKED (actual: ${ticket.status})`,
      "TICKET_NOT_BLOCKED",
    );
  }
  const updated = await db.ticket.update({
    where: { id: ticketId },
    data: { status: "DISPONIBLE" },
  });
  await logAudit({
    actorId,
    action: "tickets.unblock",
    entity: "Ticket",
    entityId: ticketId,
    before: { status: ticket.status },
    after: { status: "DISPONIBLE" },
  });
  return presentTicket(updated);
}

export type AnnulResult = {
  ticket: TicketView;
  /** true si el boleto estaba pagado: hay que reembolsar (flujo S5/S6). */
  refundRequired: boolean;
  refundAmount: number | null;
  orderCode: string | null;
};

/**
 * Anula un boleto con motivo obligatorio. Reglas (plan §2.1):
 * - Desde RESERVADO (sin pedido) o VENDIDO. Un RESERVADO con pedido
 *   PENDIENTE no se anula suelto: se cancela el pedido (admin/orders/cancel).
 * - La anulación libera el número solo si la rifa sigue activa y no hay
 *   sorteo congelado (Draw existente → 409).
 * - Si el boleto estaba pagado (VENDIDO), registra la necesidad de
 *   reembolso en auditoría y en la respuesta; el reembolso lo ejecuta S6.
 * - Si el boleto pertenecía a una reserva ACTIVA, se quita el número de
 *   la reserva (y se cancela si queda vacía).
 */
export async function annulTicket(
  ticketId: string,
  actorId: string,
  reason: string,
): Promise<AnnulResult> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: { order: { select: { id: true, code: true, status: true } }, raffle: { select: { id: true, status: true, ticketPrice: true } } },
  });
  if (!ticket) throw notFound("Boleto no existe");
  if (ticket.status !== "RESERVADO" && ticket.status !== "VENDIDO") {
    throw conflict(
      `Solo se puede anular un boleto RESERVADO o VENDIDO (actual: ${ticket.status})`,
      "TICKET_NOT_ANNULLABLE",
    );
  }
  if (ticket.status === "RESERVADO" && ticket.orderId) {
    throw conflict(
      "Este boleto pertenece a un pedido PENDIENTE: cancela el pedido en vez de anular el boleto",
      "TICKET_HAS_PENDING_ORDER",
    );
  }
  const frozen = await db.draw.findUnique({ where: { raffleId: ticket.raffleId } });
  if (frozen) {
    throw conflict(
      "La rifa tiene el sorteo congelado: no se pueden anular boletos",
      "DRAW_FROZEN",
    );
  }
  if (ticket.raffle.status !== "ACTIVA" && ticket.raffle.status !== "PAUSADA") {
    throw conflict(
      `La rifa no permite anulaciones en estado ${ticket.raffle.status}`,
      "RAFFLE_NOT_ACTIVE",
    );
  }

  const refundRequired = ticket.status === "VENDIDO";
  const updated = await db.$transaction(async (tx) => {
    const t = await tx.ticket.update({
      where: { id: ticketId },
      data: { status: "ANULADO", reservationId: null },
    });
    if (ticket.reservationId) {
      const reservation = await tx.reservation.findUnique({ where: { id: ticket.reservationId } });
      if (reservation && reservation.status === "ACTIVA") {
        const remaining = (reservation.numbers as number[]).filter((n) => n !== ticket.number);
        await tx.reservation.update({
          where: { id: reservation.id },
          data: {
            numbers: remaining,
            status: remaining.length === 0 ? "CANCELADA" : "ACTIVA",
          },
        });
      }
    }
    return t;
  });
  await logAudit({
    actorId,
    action: "tickets.annul",
    entity: "Ticket",
    entityId: ticketId,
    before: { status: ticket.status, orderId: ticket.orderId },
    after: {
      status: "ANULADO",
      reason,
      refundRequired,
      refundAmount: refundRequired ? ticket.raffle.ticketPrice : null,
      orderCode: ticket.order?.code ?? null,
    },
  });
  return {
    ticket: presentTicket(updated),
    refundRequired,
    refundAmount: refundRequired ? ticket.raffle.ticketPrice : null,
    orderCode: ticket.order?.code ?? null,
  };
}

export type VerifyResult = {
  code: string;
  number: number;
  status: string;
  raffleTitle: string;
  raffleId: string;
  drawAt: Date;
  isWinner: boolean;
};

/**
 * Verificación pública por código (plan §2.10): devuelve si el boleto
 * ganó, sin exponer datos privados del comprador (sin email/teléfono).
 */
export async function verifyTicket(code: string): Promise<VerifyResult> {
  const ticket = await db.ticket.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: { raffle: { select: { id: true, title: true, drawAt: true } } },
  });
  if (!ticket) throw notFound("Boleto no encontrado");
  const draw = await db.draw.findUnique({ where: { raffleId: ticket.raffleId } });
  return {
    code: ticket.code,
    number: ticket.number,
    status: ticket.status,
    raffleTitle: ticket.raffle.title,
    raffleId: ticket.raffle.id,
    drawAt: ticket.raffle.drawAt,
    isWinner: draw?.winningTicketId === ticket.id,
  };
}
