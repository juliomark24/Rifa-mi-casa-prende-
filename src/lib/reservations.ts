// Reservas temporales de boletos (plan §2.1, §2.11, §2.12).
// Reglas:
//  - La reserva se crea en la misma transacción que marca los boletos
//    RESERVADO. Un número nunca se vende dos veces: constraint único
//    (raffleId, number) + verificación dentro de la transacción +
//    conversión de P2002 a 409. En PostgreSQL el constraint es el
//    respaldo frente a carreras; en SQLite las escrituras se serializan.
//  - Reserva ~10 min por defecto (Setting RESERVATION_MINUTES, env o 10).
//  - Si un número ya no está disponible → 409 con sugerencia de cercanos.
//  - La liberación de vencidas es idempotente por reservationId.
import crypto from "node:crypto";
import { z } from "zod";
import type { Prisma, Raffle } from "../generated/prisma/client";
import { db, type Tx } from "./db";
import { logAudit } from "./audit";
import { ApiError, conflict, notFound } from "./errors";

export const reserveSchema = z
  .object({
    numbers: z.array(z.number().int()).min(1).max(100).optional(),
    quantity: z.number().int().min(1).max(100).optional(),
    buyerEmail: z.string().trim().toLowerCase().email("Email inválido"),
    userId: z.string().trim().max(64).optional(),
  })
  .refine((v) => v.numbers !== undefined || v.quantity !== undefined, {
    message: "Indica numbers o quantity",
  });

export type ReserveInput = z.infer<typeof reserveSchema>;

export type ReservationResult = {
  reservationId: string;
  raffleId: string;
  buyerEmail: string;
  numbers: number[];
  expiresAt: Date;
  reused?: boolean;
};

/** Minutos de vigencia de una reserva: Setting > env > 10 (plan §2.1). */
export async function getReservationMinutes(): Promise<number> {
  try {
    const setting = await db.setting.findUnique({ where: { key: "RESERVATION_MINUTES" } });
    if (setting) {
      const n = Number(setting.value);
      if (Number.isInteger(n) && n > 0 && n <= 1440) return n;
    }
  } catch {
    // Sin BD: cae al env.
  }
  const env = Number(process.env.RESERVATION_MINUTES);
  if (Number.isInteger(env) && env > 0 && env <= 1440) return env;
  return 10;
}

export function generateTicketCode(raffleId: string, number: number): string {
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `PR-${rand}-${String(number).padStart(4, "0")}`;
}

/** Números ocupados de una rifa (cualquier boleto que no esté libre). */
export async function occupiedNumbers(
  client: typeof db | Tx,
  raffleId: string,
): Promise<Map<number, string>> {
  const tickets = await client.ticket.findMany({
    where: { raffleId },
    select: { number: true, status: true },
  });
  const map = new Map<number, string>();
  for (const t of tickets) {
    // ANULADO libera el número (plan §2.1); DISPONIBLE también está libre.
    if (t.status === "ANULADO" || t.status === "DISPONIBLE") continue;
    map.set(t.number, t.status);
  }
  return map;
}

/** Números disponibles, ordenados. */
export async function availableNumbers(
  client: typeof db | Tx,
  raffle: Raffle,
): Promise<number[]> {
  const occupied = await occupiedNumbers(client, raffle.id);
  const out: number[] = [];
  for (let n = 1; n <= raffle.totalTickets; n++) {
    if (!occupied.has(n)) out.push(n);
  }
  return out;
}

/** Sugerencia de números cercanos a uno ocupado (alternando +1/-1, +2/-2…). */
export function suggestNearby(
  wanted: number,
  available: number[],
  count = 3,
): number[] {
  const set = new Set(available);
  const out: number[] = [];
  for (let d = 1; d <= Math.max(wanted, 1000) && out.length < count; d++) {
    if (set.has(wanted + d)) out.push(wanted + d);
    if (out.length >= count) break;
    if (set.has(wanted - d)) out.push(wanted - d);
  }
  return out;
}

function isTransientLockError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: string }).code
      : undefined;
  // SQLITE_BUSY / P2034 (bloqueo) y P2028 (timeout esperando transacción):
  // la transacción se revirtió, reintentar es seguro.
  return (
    /database is locked|database table is locked|SQLITE_BUSY|busy/i.test(msg) ||
    code === "P2034" ||
    code === "P2028"
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

async function loadRaffleForSale(
  client: typeof db | Tx,
  raffleId: string,
): Promise<Raffle> {
  const raffle = await client.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle) throw notFound("Rifa no existe");
  if (raffle.status !== "ACTIVA") {
    throw new ApiError(
      409,
      `La rifa no está activa (estado: ${raffle.status}); no se pueden reservar boletos`,
      "RAFFLE_NOT_ACTIVE",
    );
  }
  return raffle;
}

/** Cuenta boletos ya en manos del comprador (reservados + vendidos). */
async function countBuyerTickets(
  client: typeof db | Tx,
  raffleId: string,
  buyerEmail: string,
): Promise<number> {
  return client.ticket.count({
    where: {
      raffleId,
      buyerEmail: buyerEmail.toLowerCase(),
      status: { in: ["RESERVADO", "VENDIDO"] },
    },
  });
}

function checkLimits(
  raffle: Raffle,
  requested: number,
  alreadyOwned: number,
): void {
  if (raffle.maxTicketsPerPurchase !== null && requested > raffle.maxTicketsPerPurchase) {
    throw conflict(
      `Máximo ${raffle.maxTicketsPerPurchase} boletos por compra en esta rifa`,
      "MAX_PER_PURCHASE",
    );
  }
  if (
    raffle.maxTicketsPerCustomer !== null &&
    alreadyOwned + requested > raffle.maxTicketsPerCustomer
  ) {
    throw conflict(
      `Máximo ${raffle.maxTicketsPerCustomer} boletos por cliente en esta rifa (ya tienes ${alreadyOwned})`,
      "MAX_PER_CUSTOMER",
    );
  }
}

/**
 * Marca números como RESERVADO dentro de una transacción ya abierta.
 * Devuelve los números finalmente asignados. Lanza 409 si alguno ya no
 * está disponible (con sugerencia de cercanos). Es la única vía por la
 * que un boleto pasa a RESERVADO: nunca se hace fuera de transacción.
 * - Fila inexistente → create (P2002 = carrera perdida → 409).
 * - Fila DISPONIBLE/ANULADO → updateMany condicional (count 0 = carrera → 409).
 * - Fila RESERVADO/VENDIDO/BLOCKED → 409 inmediato.
 */
export async function reserveNumbersTx(
  tx: Tx,
  raffle: Raffle,
  opts: {
    numbers?: number[];
    quantity?: number;
    buyerEmail: string;
    reservationId?: string | null;
    orderId?: string | null;
    affiliateId?: string | null;
  },
): Promise<number[]> {
  const buyerEmail = opts.buyerEmail.toLowerCase();
  let numbers: number[];
  if (opts.numbers && opts.numbers.length > 0) {
    numbers = [...new Set(opts.numbers)].sort((a, b) => a - b);
    for (const n of numbers) {
      if (!Number.isInteger(n) || n < 1 || n > raffle.totalTickets) {
        throw new ApiError(400, `Número inválido: ${n} (rango 1–${raffle.totalTickets})`, "INVALID_NUMBER");
      }
    }
  } else if (opts.quantity) {
    const available = await availableNumbers(tx, raffle);
    if (available.length < opts.quantity) {
      throw conflict(
        `Solo quedan ${available.length} boletos disponibles en esta rifa`,
        "NOT_ENOUGH_TICKETS",
      );
    }
    // Asignación aleatoria entre disponibles (plan §2.1).
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }
    numbers = available.slice(0, opts.quantity).sort((a, b) => a - b);
  } else {
    throw new ApiError(400, "Indica numbers o quantity", "VALIDATION_ERROR");
  }

  const existing = await tx.ticket.findMany({
    where: { raffleId: raffle.id, number: { in: numbers } },
    select: { id: true, number: true, status: true },
  });
  const byNumber = new Map(existing.map((t) => [t.number, t]));
  const available = await availableNumbers(tx, raffle);
  for (const n of numbers) {
    const row = byNumber.get(n);
    if (row && row.status !== "DISPONIBLE" && row.status !== "ANULADO") {
      const suggestions = suggestNearby(n, available, 3);
      throw conflict(
        `El boleto ${n} ya no está disponible${suggestions.length ? `. Números cercanos disponibles: ${suggestions.join(", ")}` : ". No quedan números cercanos disponibles"}`,
        "TICKET_UNAVAILABLE",
      );
    }
  }

  for (const n of numbers) {
    const row = byNumber.get(n);
    const data = {
      status: "RESERVADO" as const,
      reservationId: opts.reservationId ?? null,
      orderId: opts.orderId ?? null,
      buyerEmail,
      affiliateId: opts.affiliateId ?? null,
    };
    try {
      if (!row) {
        await tx.ticket.create({
          data: {
            raffleId: raffle.id,
            number: n,
            code: generateTicketCode(raffle.id, n),
            ...data,
          },
        });
      } else if (row.status === "DISPONIBLE" || row.status === "ANULADO") {
        const updated = await tx.ticket.updateMany({
          where: { id: row.id, status: { in: ["DISPONIBLE", "ANULADO"] } },
          data: { ...data, code: generateTicketCode(raffle.id, n) },
        });
        if (updated.count !== 1) {
          throw conflict(`El boleto ${n} ya no está disponible`, "TICKET_UNAVAILABLE");
        }
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        const suggestions = suggestNearby(n, await availableNumbers(tx, raffle), 3);
        throw conflict(
          `El boleto ${n} ya no está disponible${suggestions.length ? `. Números cercanos disponibles: ${suggestions.join(", ")}` : ""}`,
          "TICKET_UNAVAILABLE",
        );
      }
      throw err;
    }
  }
  return numbers;
}

/**
 * Crea una reserva temporal (~10 min). Idempotente por clave: repetir la
 * misma Idempotency-Key devuelve la misma reserva sin crear otra.
 * Reintenta errores transitorios de bloqueo de SQLite (P2034 / locked).
 */
export async function createReservation(input: {
  raffleId: string;
  buyerEmail: string;
  userId?: string | null;
  numbers?: number[];
  quantity?: number;
  idempotencyKey?: string | null;
}): Promise<ReservationResult> {
  const buyerEmail = input.buyerEmail.trim().toLowerCase();
  const raffle = await loadRaffleForSale(db, input.raffleId);
  const requested = input.numbers?.length ?? input.quantity ?? 0;
  if (requested < 1) throw new ApiError(400, "Indica numbers o quantity", "VALIDATION_ERROR");
  checkLimits(raffle, requested, await countBuyerTickets(db, raffle.id, buyerEmail));

  if (input.idempotencyKey) {
    const existing = await db.reservation.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing && existing.raffleId === raffle.id) {
      return {
        reservationId: existing.id,
        raffleId: existing.raffleId,
        buyerEmail: existing.buyerEmail,
        numbers: (existing.numbers as number[]).slice().sort((a, b) => a - b),
        expiresAt: existing.expiresAt,
        reused: true,
      };
    }
  }

  const minutes = await getReservationMinutes();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const result = await db.$transaction(async (tx) => {
        const fresh = await loadRaffleForSale(tx, raffle.id);
        checkLimits(fresh, requested, await countBuyerTickets(tx, fresh.id, buyerEmail));
        const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
        const reservation = await tx.reservation.create({
          data: {
            raffleId: fresh.id,
            buyerEmail,
            userId: input.userId ?? null,
            numbers: [],
            expiresAt,
            idempotencyKey: input.idempotencyKey ?? null,
            status: "ACTIVA",
          },
        });
        const numbers = await reserveNumbersTx(tx, fresh, {
          numbers: input.numbers,
          quantity: input.quantity,
          buyerEmail,
          reservationId: reservation.id,
        });
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { numbers },
        });
        return {
          reservationId: reservation.id,
          raffleId: fresh.id,
          buyerEmail,
          numbers,
          expiresAt,
        };
        // Ventana amplia: con 100 compradores concurrentes por el mismo
        // número, las transacciones hacen cola (SQLite serializa).
      }, { maxWait: 20000, timeout: 30000 });
      return result;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Carrera perdida en la creación (reserva con misma clave o boleto):
        // si fue la clave de idempotencia, devuelve la reserva existente.
        if (input.idempotencyKey) {
          const existing = await db.reservation.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (existing) {
            return {
              reservationId: existing.id,
              raffleId: existing.raffleId,
              buyerEmail: existing.buyerEmail,
              numbers: (existing.numbers as number[]).slice().sort((a, b) => a - b),
              expiresAt: existing.expiresAt,
              reused: true,
            };
          }
        }
        throw conflict("Uno de los boletos ya no está disponible", "TICKET_UNAVAILABLE");
      }
      if (err instanceof ApiError) throw err;
      if (isTransientLockError(err) && attempt < 5) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No se pudo crear la reserva");
}

export type ReleaseResult = {
  ok: boolean;
  released: number;
  ticketsReleased: number;
  failed: number;
  reservationIds: string[];
  failures: Array<{ reservationId: string; reason: string }>;
};

/**
 * Libera reservas vencidas (RESERVADO → DISPONIBLE). Idempotente por
 * reservationId: la transición es condicional (solo si sigue ACTIVA y
 * vencida), así que re-ejecutarla no tiene efecto duplicado. Cada
 * liberación queda en auditoría. Un fallo parcial no detiene el resto.
 * NOTA: no toca pedidos PENDIENTE de transferencia manual: esos boletos
 * quedan RESERVADO hasta que un admin los confirme o cancele (S5/S6),
 * porque el comprador necesita horas —no 10 minutos— para transferir.
 */
export async function releaseExpiredReservations(now = new Date()): Promise<ReleaseResult> {
  const expired = await db.reservation.findMany({
    where: { status: "ACTIVA", expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" },
    take: 500,
  });
  const result: ReleaseResult = {
    ok: true,
    released: 0,
    ticketsReleased: 0,
    failed: 0,
    reservationIds: [],
    failures: [],
  };
  for (const reservation of expired) {
    try {
      const { transitioned, freed } = await db.$transaction(async (tx) => {
        const updated = await tx.reservation.updateMany({
          where: { id: reservation.id, status: "ACTIVA", expiresAt: { lte: now } },
          data: { status: "VENCIDA" },
        });
        if (updated.count !== 1) return { transitioned: false, freed: 0 }; // ya liberada por otra ejecución
        // Solo boletos aún RESERVADO y sin pedido (una compra marca la
        // reserva CONFIRMADA, así que no debería haber pedido aquí).
        const tickets = await tx.ticket.updateMany({
          where: {
            reservationId: reservation.id,
            status: "RESERVADO",
            orderId: null,
          },
          data: { status: "DISPONIBLE", reservationId: null },
        });
        return { transitioned: true, freed: tickets.count };
      });
      if (!transitioned) continue; // otra ejecución ya la liberó: idempotente
      result.released += 1;
      result.ticketsReleased += freed;
      result.reservationIds.push(reservation.id);
      await logAudit({
        action: "reservations.release-expired",
        entity: "Reservation",
        entityId: reservation.id,
        before: { status: "ACTIVA", expiresAt: reservation.expiresAt.toISOString() },
        after: { status: "VENCIDA", ticketsReleased: freed, releasedAt: now.toISOString() },
      });
    } catch (err) {
      result.failed += 1;
      result.ok = false;
      result.failures.push({
        reservationId: reservation.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** Carga una reserva ACTIVA y vigente, o lanza 404/409. */
export async function getActiveReservation(id: string) {
  const reservation = await db.reservation.findUnique({ where: { id } });
  if (!reservation) throw notFound("Reserva no existe");
  if (reservation.status !== "ACTIVA") {
    throw conflict(`La reserva ya no está activa (estado: ${reservation.status})`, "RESERVATION_NOT_ACTIVE");
  }
  if (reservation.expiresAt <= new Date()) {
    throw conflict("La reserva venció; vuelve a reservar los boletos", "RESERVATION_EXPIRED");
  }
  return reservation;
}
