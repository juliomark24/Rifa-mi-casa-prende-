// Máquina de estados de rifa — 11 estados (plan §2.7) + reglas de cambios
// sensibles (§2.7, §2.20) + avisos a compradores (§2.16, el envío real es S8).
//
// Estados: BORRADOR → PENDIENTE_APROBACION → PROGRAMADA → ACTIVA →
// PAUSADA → AGOTADA → CERRADA → EN_SORTEO → GANADOR_PUBLICADO → FINALIZADA
// | CANCELADA (desde casi cualquier estado previo al sorteo).
//
// Reglas del plan §2.7:
// - No cambiar el precio con ventas hechas (sin doble aprobación, §2.20).
// - No cambiar el total de números ni el premio en silencio: requiere
//   aprobación de superadministrador + aviso a compradores.
// - No cambiar la fecha de sorteo sin registro en auditoría + aviso.
// - Pausar congela las ventas sin borrar nada.
// - Agotar es automático al venderse el último boleto.
// - La cancelación activa el flujo de reembolsos: aquí se registra la
//   intención (notificación a cada comprador + auditoría); el flujo de
//   reembolso en sí lo implementan S5/S6.
import { badRequest, conflict, notFound } from "./errors";
import { db, type Tx } from "./db";
import { logAudit, logChange } from "./audit";
import type { Raffle, RaffleStatus } from "../generated/prisma/client";

export const RAFFLE_STATUSES: RaffleStatus[] = [
  "BORRADOR",
  "PENDIENTE_APROBACION",
  "PROGRAMADA",
  "ACTIVA",
  "PAUSADA",
  "AGOTADA",
  "CERRADA",
  "EN_SORTEO",
  "GANADOR_PUBLICADO",
  "FINALIZADA",
  "CANCELADA",
];

/** Estados terminales: desde aquí no hay ninguna transición. */
export const RAFFLE_TERMINAL_STATUSES: RaffleStatus[] = ["FINALIZADA", "CANCELADA"];

/** Estados en los que la rifa ya no admite edición de campos. */
export const RAFFLE_FROZEN_STATUSES: RaffleStatus[] = [
  "CERRADA",
  "EN_SORTEO",
  "GANADOR_PUBLICADO",
  "FINALIZADA",
  "CANCELADA",
];

/** Estados visibles en el catálogo público por defecto (sin ?status=). */
export const RAFFLE_PUBLIC_STATUSES: RaffleStatus[] = [
  "PROGRAMADA",
  "ACTIVA",
  "PAUSADA",
  "AGOTADA",
  "CERRADA",
  "EN_SORTEO",
  "GANADOR_PUBLICADO",
  "FINALIZADA",
];

/** Tabla de transiciones permitidas (plan §2.7). */
export const RAFFLE_TRANSITIONS: Record<RaffleStatus, RaffleStatus[]> = {
  BORRADOR: ["PENDIENTE_APROBACION", "CANCELADA"],
  // Volver a BORRADOR = la aprobación fue rechazada, se corrige y se reenvía.
  PENDIENTE_APROBACION: ["PROGRAMADA", "BORRADOR", "CANCELADA"],
  PROGRAMADA: ["ACTIVA", "CANCELADA"],
  ACTIVA: ["PAUSADA", "AGOTADA", "CERRADA", "CANCELADA"],
  PAUSADA: ["ACTIVA", "CANCELADA"],
  AGOTADA: ["CERRADA", "CANCELADA"],
  CERRADA: ["EN_SORTEO", "CANCELADA"],
  EN_SORTEO: ["GANADOR_PUBLICADO"],
  GANADOR_PUBLICADO: ["FINALIZADA"],
  FINALIZADA: [],
  CANCELADA: [],
};

export function canTransition(from: RaffleStatus, to: RaffleStatus): boolean {
  return RAFFLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionAllowed(from: RaffleStatus, to: RaffleStatus): void {
  if (!canTransition(from, to)) {
    throw conflict(
      `Transición no permitida: ${from} → ${to}`,
      "INVALID_TRANSITION",
    );
  }
}

// ---------------------------------------------------------------- ventas
export async function getSoldCount(raffleId: string): Promise<number> {
  return db.ticket.count({ where: { raffleId, status: "VENDIDO" } });
}

export async function getReservedCount(raffleId: string): Promise<number> {
  return db.ticket.count({ where: { raffleId, status: "RESERVADO" } });
}

export async function hasSales(raffleId: string): Promise<boolean> {
  const [sold, confirmedOrders] = await Promise.all([
    db.ticket.count({ where: { raffleId, status: "VENDIDO" } }),
    db.order.count({ where: { raffleId, status: "CONFIRMADO" } }),
  ]);
  return sold > 0 || confirmedOrders > 0;
}

export type RaffleSalesSummary = {
  soldCount: number;
  reservedCount: number;
  availableCount: number;
  percentSold: number;
};

export async function getRaffleSalesSummary(
  raffle: Pick<Raffle, "id" | "totalTickets">,
): Promise<RaffleSalesSummary> {
  const [soldCount, reservedCount] = await Promise.all([
    getSoldCount(raffle.id),
    getReservedCount(raffle.id),
  ]);
  const availableCount = Math.max(0, raffle.totalTickets - soldCount - reservedCount);
  return {
    soldCount,
    reservedCount,
    availableCount,
    percentSold:
      raffle.totalTickets > 0 ? Math.round((soldCount / raffle.totalTickets) * 100) : 0,
  };
}

// ---------------------------------------------------------------- avisos a compradores
/** Emails únicos de los compradores de una rifa (pedidos PENDIENTE/CONFIRMADO). */
export async function getRaffleBuyerEmails(raffleId: string): Promise<string[]> {
  const orders = await db.order.findMany({
    where: { raffleId, status: { in: ["PENDIENTE", "CONFIRMADO"] } },
    select: { buyerEmail: true },
    distinct: ["buyerEmail"],
  });
  return orders.map((o) => o.buyerEmail);
}

/**
 * Crea las notificaciones (estado PENDIENTE) para los compradores de una
 * rifa. El envío real lo hace el motor de notificaciones (S8, plan §2.16);
 * aquí solo queda el registro, que es lo que exige §2.7/§2.18.
 */
export async function notifyRaffleBuyers(
  tx: Tx,
  raffleId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const emails = await tx.order.findMany({
    where: { raffleId, status: { in: ["PENDIENTE", "CONFIRMADO"] } },
    select: { buyerEmail: true },
    distinct: ["buyerEmail"],
  });
  if (emails.length === 0) return 0;
  await tx.notification.createMany({
    data: emails.map((o) => ({
      event,
      channel: "EMAIL" as const,
      recipient: o.buyerEmail,
      status: "PENDIENTE" as const,
      payload: { raffleId, ...payload },
    })),
  });
  return emails.length;
}

// ---------------------------------------------------------------- doble aprobación (§2.20)
/**
 * Valida la doble aprobación: el aprobador debe existir, ser SUPERADMIN y
 * ser distinto del actor. Devuelve el id del aprobador o lanza 409.
 */
export async function validateSecondApproval(
  actorId: string,
  approvedById: string | null | undefined,
): Promise<string> {
  if (!approvedById) {
    throw conflict(
      "Este cambio con ventas hechas requiere doble aprobación: un segundo superadministrador debe aprobarlo (approvedById)",
      "REQUIRES_SECOND_APPROVAL",
    );
  }
  if (approvedById === actorId) {
    throw conflict(
      "La doble aprobación exige un segundo administrador distinto del que hace el cambio",
      "REQUIRES_SECOND_APPROVAL",
    );
  }
  const approver = await db.user.findUnique({ where: { id: approvedById } });
  if (!approver || approver.role !== "SUPERADMIN") {
    throw conflict(
      "El aprobador debe ser un superadministrador existente",
      "REQUIRES_SECOND_APPROVAL",
    );
  }
  return approvedById;
}

// ---------------------------------------------------------------- edición (PATCH)
export type RafflePatchChanges = {
  title?: string;
  description?: string;
  prize?: string;
  imageUrl?: string | null;
  ticketPrice?: number;
  totalTickets?: number;
  drawAt?: Date;
  rules?: string;
  licenseNumber?: string | null;
  minTicketsToDraw?: number | null;
  maxTicketsPerPurchase?: number | null;
  maxTicketsPerCustomer?: number | null;
  reason?: string;
  approvedById?: string | null;
};

/** Campos sensibles (§2.7 + §2.20): con ventas hechas exigen doble aprobación. */
export const RAFFLE_SENSITIVE_FIELDS = ["ticketPrice", "totalTickets", "prize"] as const;

export async function applyRafflePatch(opts: {
  raffleId: string;
  changes: RafflePatchChanges;
  actorId: string;
  ipAddress?: string | null;
}): Promise<Raffle> {
  const { raffleId, changes, actorId, ipAddress } = opts;
  const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle) throw notFound("Rifa no existe");
  if (RAFFLE_FROZEN_STATUSES.includes(raffle.status)) {
    throw conflict(
      `No se puede editar una rifa en estado ${raffle.status}`,
      "RAFFLE_FROZEN",
    );
  }

  const soldCount = await getSoldCount(raffleId);
  const hasSold = soldCount > 0;

  // Cambios sensibles con ventas → doble aprobación (§2.20).
  const touchesSensitive = RAFFLE_SENSITIVE_FIELDS.some(
    (f) => changes[f] !== undefined && changes[f] !== raffle[f],
  );
  let approvedById: string | null = null;
  if (touchesSensitive && hasSold) {
    approvedById = await validateSecondApproval(actorId, changes.approvedById);
  }

  // La fecha de sorteo nunca cambia sin motivo + registro + aviso (§2.7).
  const drawAtChanged =
    changes.drawAt !== undefined && changes.drawAt.getTime() !== raffle.drawAt.getTime();
  if (drawAtChanged) {
    if (!changes.reason || changes.reason.trim().length === 0) {
      throw badRequest("Cambiar la fecha de sorteo exige un motivo (reason)");
    }
    if (changes.drawAt! < new Date()) {
      throw badRequest("La fecha de sorteo no puede estar en el pasado");
    }
  }

  // No se puede reducir el total de números por debajo de lo ya vendido.
  if (
    changes.totalTickets !== undefined &&
    changes.totalTickets < soldCount
  ) {
    throw badRequest(
      `El total de boletos (${changes.totalTickets}) no puede ser menor que los ${soldCount} ya vendidos`,
    );
  }

  const { reason, approvedById: _ignored, ...fields } = changes;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data[key] = value;
  }
  if (Object.keys(data).length === 0) {
    throw badRequest("No hay cambios para aplicar");
  }

  const updated = await db.$transaction(async (tx) => {
    const r = await tx.raffle.update({ where: { id: raffleId }, data });
    // Avisos a compradores por cada cambio sensible o de fecha (§2.7).
    if (hasSold) {
      if (changes.ticketPrice !== undefined && changes.ticketPrice !== raffle.ticketPrice) {
        await notifyRaffleBuyers(tx, raffleId, "raffle_price_changed", {
          before: raffle.ticketPrice,
          after: changes.ticketPrice,
          reason: reason ?? null,
        });
      }
      if (changes.prize !== undefined && changes.prize !== raffle.prize) {
        await notifyRaffleBuyers(tx, raffleId, "raffle_prize_changed", {
          before: raffle.prize,
          after: changes.prize,
          reason: reason ?? null,
        });
      }
      if (changes.totalTickets !== undefined && changes.totalTickets !== raffle.totalTickets) {
        await notifyRaffleBuyers(tx, raffleId, "raffle_total_tickets_changed", {
          before: raffle.totalTickets,
          after: changes.totalTickets,
          reason: reason ?? null,
        });
      }
      if (drawAtChanged) {
        await notifyRaffleBuyers(tx, raffleId, "raffle_draw_date_changed", {
          before: raffle.drawAt.toISOString(),
          after: changes.drawAt!.toISOString(),
          reason: reason ?? null,
        });
      }
    }
    return r;
  });

  // Registro antes/después por campo cambiado (P28, §2.20).
  for (const [key, value] of Object.entries(data)) {
    await logChange({
      actorId,
      entity: "Raffle",
      entityId: raffleId,
      field: key,
      beforeValue: raffle[key as keyof Raffle],
      afterValue: value,
      reason: reason ?? null,
      approvedById,
    });
  }
  await logAudit({
    actorId,
    action: "raffles.update",
    entity: "Raffle",
    entityId: raffleId,
    before: { status: raffle.status, ticketPrice: raffle.ticketPrice, totalTickets: raffle.totalTickets, prize: raffle.prize, drawAt: raffle.drawAt.toISOString() },
    after: { ...data, drawAt: data.drawAt instanceof Date ? data.drawAt.toISOString() : undefined },
    ipAddress,
  });
  return updated;
}

// ---------------------------------------------------------------- transiciones
export async function applyRaffleTransition(opts: {
  raffleId: string;
  to: RaffleStatus;
  actorId?: string | null;
  reason?: string | null;
  ipAddress?: string | null;
}): Promise<Raffle> {
  const { raffleId, to, actorId, reason, ipAddress } = opts;
  const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle) throw notFound("Rifa no existe");
  assertTransitionAllowed(raffle.status, to);

  // Publicar/programar exige que el país de la rifa esté ACTIVO (§2.9:
  // los demás estados no permiten publicar rifas en ese país).
  if (to === "PROGRAMADA") {
    const country = await db.country.findUnique({ where: { id: raffle.countryId } });
    if (!country || country.status !== "ACTIVO") {
      throw conflict(
        "El país de la rifa no está ACTIVO; no se puede programar la rifa",
        "COUNTRY_NOT_ACTIVE",
      );
    }
  }

  const updated = await db.$transaction(async (tx) => {
    const r = await tx.raffle.update({ where: { id: raffleId }, data: { status: to } });
    if (to === "CANCELADA") {
      // La cancelación ACTIVA el flujo de reembolsos (§2.7): aquí se
      // registra la intención y se avisa a cada comprador. El reembolso
      // en sí (S5/S6) procesa estas notificaciones y las órdenes pagadas.
      await notifyRaffleBuyers(tx, raffleId, "raffle_cancelled_refund", {
        reason: reason ?? null,
        note: "La rifa fue cancelada. El reembolso se procesará según las bases.",
      });
    }
    return r;
  });

  await logChange({
    actorId: actorId ?? null,
    entity: "Raffle",
    entityId: raffleId,
    field: "status",
    beforeValue: raffle.status,
    afterValue: to,
    reason: reason ?? null,
  });
  await logAudit({
    actorId: actorId ?? null,
    action: "raffles.transition",
    entity: "Raffle",
    entityId: raffleId,
    before: { status: raffle.status },
    after: { status: to, reason: reason ?? null },
    ipAddress,
  });
  return updated;
}

/**
 * Agotado automático (§2.7): si la rifa está ACTIVA y ya no quedan boletos
 * disponibles, pasa a AGOTADA. La llama el flujo de ventas (S4) tras
 * confirmar una compra; es idempotente (si ya no está ACTIVA, no hace nada).
 */
export async function markSoldOutIfNeeded(
  raffleId: string,
  actorId?: string | null,
): Promise<Raffle | null> {
  const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle || raffle.status !== "ACTIVA") return null;
  const summary = await getRaffleSalesSummary(raffle);
  if (summary.availableCount > 0) return null;
  return applyRaffleTransition({
    raffleId,
    to: "AGOTADA",
    actorId,
    reason: "Agotada automáticamente al venderse el último boleto",
  });
}
