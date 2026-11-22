// Sorteo verificable commit-reveal (plan §2.5, aclaración 1).
// Algoritmo publicado: "SHA256-CHAIN-v1".
//
//  1. Congelar elegibles: serialización DETERMINISTA de la lista
//     (números ordenados, JSON sin espacios) → eligibleSnapshot.
//  2. hashElegibles = SHA256(eligibleSnapshot).
//  3. commitment = SHA256(seed + ":" + hashElegibles), publicado ANTES del
//     sorteo con la semilla secreta (CSPRNG, 32 bytes).
//  4. Al ejecutar: se revela la semilla; winnerIndex =
//     (primeros 8 bytes de SHA256(seed + ":" + hashElegibles) como entero)
//     mod totalElegibles; el ganador es elegibles[winnerIndex].
//  5. Verificación independiente: cualquiera con la semilla revelada y la
//     lista congelada reproduce el ganador con verifyDraw() o con el script
//     scripts/verify-draw.mjs (solo node:crypto, sin el servidor).
//
// Flujo en base de datos (S7):
//   freezeEligible()  → calcula la lista elegible y su snapshot canónico.
//   commitDraw()      → congela + genera la semilla + publica el commitment
//                        (crea Draw, rifa CERRADA → EN_SORTEO). La semilla
//                        queda guardada en Draw.seed pero NINGUNA respuesta
//                        de API la devuelve hasta que el sorteo se ejecuta:
//                        "revelar" es hacerla pública, no crearla. (El
//                        comentario del schema "seed nullable hasta el reveal"
//                        se interpreta así: sin semilla guardada no habría
//                        forma de verificar el compromiso después; un sorteo
//                        creado a mano con seed null no se puede ejecutar.)
//   executeDraw()     → revela la semilla, calcula el ganador determinista,
//                        marca la rifa GANADOR_PUBLICADO y abre el
//                        WinnerCase en PENDIENTE_CONTACTO (ver src/lib/winner.ts).
//                        "Ganador publicado" es independiente de "premio
//                        entregado / caso cerrado" (aclaración 2).
//
// Formato canónico del snapshot (documentado, reproducible por cualquiera):
//   JSON compacto, sin espacios, de los números de boleto elegibles únicos
//   ordenados de menor a mayor. Ejemplo: "[1,3,5]".
//   hashElegibles = SHA256 hexadecimal (minúsculas) de ese texto exacto.
//   commitment    = SHA256 hexadecimal de "<seed>:<hashElegibles>".
//   winnerIndex   = (primeros 8 bytes de SHA256("<seed>:<hashElegibles>")
//                    como entero sin signo) mod totalElegibles.
//
// Elegible (plan §2.1): boleto VENDIDO + pago confirmado + no anulado.
//   - Sin pedido asociado: VENDIDO basta (boleto emitido como vendido).
//   - Con pedido: el pedido debe estar CONFIRMADO y tener al menos un pago
//     APROBADO. Un boleto VENDIDO con pedido PENDIENTE no es elegible.
//
// Bloqueos P7: no se congela ni se ejecuta si hay pedidos pendientes de
// confirmación (PENDIENTE o DISPUTADO), pagos PENDIENTE o reservas ACTIVAS
// en esa rifa. Bloqueo P8: una rifa solo se sortea una vez (Draw.raffleId
// único + executedAt; un segundo commit o execute se rechaza con 409).
import crypto from "node:crypto";
import { Prisma } from "../generated/prisma/client";
import { db, type Tx } from "./db";
import { conflict, notFound } from "./errors";

export const DRAW_ALGORITHM = "SHA256-CHAIN-v1";

/** Estados de rifa en los que se puede congelar/ejecutar el sorteo. */
export const DRAWABLE_RAFFLE_STATUSES = ["CERRADA", "EN_SORTEO"] as const;

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/** Serialización determinista: números únicos, orden ascendente, JSON compacto. */
export function serializeEligible(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  return JSON.stringify(sorted);
}

export function hashEligibleSnapshot(serialized: string): string {
  return sha256Hex(serialized);
}

/** Semilla criptográficamente segura (CSPRNG, 32 bytes hex). */
export function generateSeed(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Compromiso publicado antes del sorteo. */
export function createCommitment(seed: string, hashElegibles: string): string {
  return sha256Hex(`${seed}:${hashElegibles}`);
}

/** Índice del ganador: determinista a partir de seed + hashElegibles. */
export function drawWinnerIndex(seed: string, hashElegibles: string, total: number): number {
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error("totalElegibles debe ser un entero positivo");
  }
  const digest = sha256Hex(`${seed}:${hashElegibles}`);
  const value = BigInt(`0x${digest.slice(0, 16)}`);
  return Number(value % BigInt(total));
}

export type ComputedDraw = {
  seed: string;
  eligibleSnapshot: string;
  hashElegibles: string;
  commitment: string;
  winnerIndex: number;
  winnerNumber: number;
  totalElegibles: number;
  algorithm: string;
};

/** Calcula un sorteo completo a partir de la lista de elegibles. */
export function computeDraw(eligibleNumbers: number[], seed?: string): ComputedDraw {
  const usedSeed = seed ?? generateSeed();
  const eligibleSnapshot = serializeEligible(eligibleNumbers);
  const eligible = JSON.parse(eligibleSnapshot) as number[];
  if (eligible.length === 0) throw new Error("No hay boletos elegibles para sortear");
  const hashElegibles = hashEligibleSnapshot(eligibleSnapshot);
  const commitment = createCommitment(usedSeed, hashElegibles);
  const winnerIndex = drawWinnerIndex(usedSeed, hashElegibles, eligible.length);
  return {
    seed: usedSeed,
    eligibleSnapshot,
    hashElegibles,
    commitment,
    winnerIndex,
    winnerNumber: eligible[winnerIndex],
    totalElegibles: eligible.length,
    algorithm: DRAW_ALGORITHM,
  };
}

export type DrawVerification = {
  valid: boolean;
  commitmentMatches: boolean;
  winnerNumber: number | null;
  winnerIndex: number | null;
  reason?: string;
};

/**
 * Verificación INDEPENDIENTE: reproduce el sorteo solo con datos públicos
 * (semilla revelada + snapshot congelado + compromiso publicado).
 */
export function verifyDraw(input: {
  seed: string;
  eligibleSnapshot: string;
  commitment: string;
  winnerNumber: number;
}): DrawVerification {
  let eligible: number[];
  try {
    eligible = JSON.parse(input.eligibleSnapshot) as number[];
  } catch {
    return { valid: false, commitmentMatches: false, winnerNumber: null, winnerIndex: null, reason: "snapshot inválido" };
  }
  if (!Array.isArray(eligible) || eligible.length === 0) {
    return { valid: false, commitmentMatches: false, winnerNumber: null, winnerIndex: null, reason: "sin elegibles" };
  }
  // La serialización debe ser la canónica (si no, el snapshot fue alterado).
  if (serializeEligible(eligible) !== input.eligibleSnapshot) {
    return { valid: false, commitmentMatches: false, winnerNumber: null, winnerIndex: null, reason: "snapshot no canónico" };
  }
  const hashElegibles = hashEligibleSnapshot(input.eligibleSnapshot);
  const commitment = createCommitment(input.seed, hashElegibles);
  const commitmentMatches = commitment === input.commitment;
  const winnerIndex = drawWinnerIndex(input.seed, hashElegibles, eligible.length);
  const winnerNumber = eligible[winnerIndex];
  const valid = commitmentMatches && winnerNumber === input.winnerNumber;
  return {
    valid,
    commitmentMatches,
    winnerNumber,
    winnerIndex,
    reason: valid ? undefined : commitmentMatches ? "el número ganador no coincide" : "el compromiso no coincide (semilla o lista alteradas)",
  };
}

// ------------------------------------------------------------------ S7: DB
export type EligibleTicket = { id: string; number: number; code: string };

export type FrozenEligible = {
  raffleId: string;
  numbers: number[];
  tickets: EligibleTicket[];
  eligibleSnapshot: string;
  hashElegibles: string;
  totalElegibles: number;
};

export type DrawBlockers = {
  blocked: boolean;
  pendingOrders: number;
  disputedOrders: number;
  pendingPayments: number;
  activeReservations: number;
  reasons: string[];
};

/**
 * P7: ¿hay algo sin resolver en esta rifa que impida sortear?
 * Bloquean: pedidos PENDIENTE o DISPUTADO, pagos PENDIENTE y reservas ACTIVAS.
 */
export async function checkDrawBlockers(
  raffleId: string,
  tx: Tx | typeof db = db,
): Promise<DrawBlockers> {
  const [pendingOrders, disputedOrders, pendingPayments, activeReservations] = await Promise.all([
    tx.order.count({ where: { raffleId, status: "PENDIENTE" } }),
    tx.order.count({ where: { raffleId, status: "DISPUTADO" } }),
    tx.payment.count({ where: { status: "PENDIENTE", order: { raffleId } } }),
    tx.reservation.count({ where: { raffleId, status: "ACTIVA" } }),
  ]);
  const reasons: string[] = [];
  if (pendingOrders > 0) reasons.push(`${pendingOrders} pedido(s) pendiente(s) de confirmación`);
  if (disputedOrders > 0) reasons.push(`${disputedOrders} pedido(s) en disputa`);
  if (pendingPayments > 0) reasons.push(`${pendingPayments} pago(s) pendiente(s)`);
  if (activeReservations > 0) reasons.push(`${activeReservations} reserva(s) activa(s) sin resolver`);
  return {
    blocked: reasons.length > 0,
    pendingOrders,
    disputedOrders,
    pendingPayments,
    activeReservations,
    reasons,
  };
}

/**
 * Congela la lista de elegibles: boletos VENDIDO + pago confirmado +
 * no anulados, en orden fijo por número. No escribe en BD: el snapshot se
 * guarda al publicar el compromiso (commitDraw). Lanza 404 si la rifa no
 * existe y 409 si no hay elegibles.
 */
export async function freezeEligible(
  raffleId: string,
  tx: Tx | typeof db = db,
): Promise<FrozenEligible> {
  const raffle = await tx.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle) throw notFound("Rifa no existe");
  const sold = await tx.ticket.findMany({
    where: { raffleId, status: "VENDIDO" },
    include: { order: { include: { payments: true } } },
    orderBy: { number: "asc" },
  });
  const eligible = sold.filter((t) => {
    if (!t.orderId || !t.order) return true; // vendido sin pedido: vendido = pagado
    return (
      t.order.status === "CONFIRMADO" &&
      t.order.payments.some((p) => p.status === "APROBADO")
    );
  });
  const tickets: EligibleTicket[] = eligible.map((t) => ({ id: t.id, number: t.number, code: t.code }));
  const numbers = tickets.map((t) => t.number);
  const eligibleSnapshot = serializeEligible(numbers);
  if (numbers.length === 0) {
    throw conflict("No hay boletos elegibles para sortear en esta rifa");
  }
  return {
    raffleId,
    numbers,
    tickets,
    eligibleSnapshot,
    hashElegibles: hashEligibleSnapshot(eligibleSnapshot),
    totalElegibles: numbers.length,
  };
}

export type CommitmentPayload = {
  drawId: string;
  raffleId: string;
  commitment: string;
  hashElegibles: string;
  totalElegibles: number;
  algorithm: string;
  publishedAt: Date;
  executedAt: Date | null;
  seedRevealed: boolean;
};

export type ExecutedDrawPayload = CommitmentPayload & {
  seed: string;
  eligibleSnapshot: string;
  winnerTicketId: string;
  winnerTicketNumber: number;
  winnerTicketCode: string;
  winnerIndex: number;
};

/** Forma pública del sorteo (contrato): sin semilla hasta que se ejecuta. */
export function toPublicDraw(
  draw: {
    id: string;
    raffleId: string;
    commitment: string;
    seed: string | null;
    hashElegibles: string;
    eligibleSnapshot: string;
    totalElegibles: number;
    algorithm: string;
    executedAt: Date | null;
    createdAt: Date;
  },
  winningTicket: { id: string; number: number; code: string } | null,
): Record<string, unknown> {
  const executed = draw.executedAt !== null;
  return {
    drawId: draw.id,
    raffleId: draw.raffleId,
    commitment: draw.commitment,
    // La semilla solo se revela tras ejecutar el sorteo.
    seed: executed ? draw.seed : null,
    hashElegibles: draw.hashElegibles,
    eligibleSnapshot: draw.eligibleSnapshot,
    totalElegibles: draw.totalElegibles,
    winnerTicketId: winningTicket?.id ?? null,
    winnerTicketNumber: winningTicket?.number ?? null,
    winnerTicketCode: winningTicket?.code ?? null,
    algorithm: draw.algorithm,
    publishedAt: draw.createdAt,
    executedAt: draw.executedAt,
    seedRevealed: executed,
  };
}

/**
 * Publica el compromiso (congela elegibles + semilla CSPRNG + commitment).
 * Requiere rifa CERRADA (o EN_SORTEO sin sorteo previo), sin pagos ni
 * reservas pendientes (P7) y sin sorteo previo (P8). Todo en una transacción:
 * si dos admins intentan comprometer a la vez, el constraint único
 * Draw.raffleId hace ganar a uno y el otro recibe 409.
 * Devuelve el compromiso público (SIN la semilla).
 */
export async function commitDraw(raffleId: string, drawnById?: string): Promise<CommitmentPayload> {
  try {
    return await db.$transaction(async (tx) => {
      const raffle = await tx.raffle.findUnique({ where: { id: raffleId } });
      if (!raffle) throw notFound("Rifa no existe");
      if (!DRAWABLE_RAFFLE_STATUSES.includes(raffle.status as (typeof DRAWABLE_RAFFLE_STATUSES)[number])) {
        throw conflict(
          `La rifa debe estar CERRADA para publicar el compromiso del sorteo (estado actual: ${raffle.status})`,
        );
      }
      const existing = await tx.draw.findUnique({ where: { raffleId } });
      if (existing) {
        throw conflict("Esta rifa ya tiene un sorteo comprometido; no se puede sortear dos veces (P8)");
      }
      const blockers = await checkDrawBlockers(raffleId, tx);
      if (blockers.blocked) {
        throw conflict(`No se puede sortear: hay operaciones sin resolver — ${blockers.reasons.join("; ")}`);
      }
      const frozen = await freezeEligible(raffleId, tx);
      const seed = generateSeed();
      const commitment = createCommitment(seed, frozen.hashElegibles);
      const draw = await tx.draw.create({
        data: {
          raffleId,
          commitment,
          seed, // guardada, NO revelada: ninguna API la devuelve antes de ejecutar
          hashElegibles: frozen.hashElegibles,
          eligibleSnapshot: frozen.eligibleSnapshot,
          totalElegibles: frozen.totalElegibles,
          algorithm: DRAW_ALGORITHM,
          drawnById: drawnById ?? null,
        },
      });
      if (raffle.status === "CERRADA") {
        await tx.raffle.update({ where: { id: raffleId }, data: { status: "EN_SORTEO" } });
      }
      return {
        drawId: draw.id,
        raffleId,
        commitment: draw.commitment,
        hashElegibles: draw.hashElegibles,
        totalElegibles: draw.totalElegibles,
        algorithm: draw.algorithm,
        publishedAt: draw.createdAt,
        executedAt: null,
        seedRevealed: false,
      };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw conflict("Esta rifa ya tiene un sorteo comprometido; no se puede sortear dos veces (P8)");
    }
    throw err;
  }
}

/**
 * Ejecuta el sorteo: revela la semilla, calcula el ganador con el algoritmo
 * determinista publicado y marca la rifa GANADOR_PUBLICADO + abre el
 * WinnerCase en PENDIENTE_CONTACTO. Requiere compromiso previo, rifa
 * CERRADA o EN_SORTEO, sin operaciones pendientes (P7) y sin ejecución
 * previa (P8). Todo en una transacción.
 */
export async function executeDraw(raffleId: string, drawnById?: string): Promise<ExecutedDrawPayload> {
  return db.$transaction(async (tx) => {
    const draw = await tx.draw.findUnique({ where: { raffleId } });
    if (!draw) {
      throw notFound("Esta rifa aún no tiene compromiso publicado; primero publica el compromiso del sorteo");
    }
    if (draw.executedAt) {
      throw conflict("Esta rifa ya fue sorteada; no se puede sortear dos veces (P8)");
    }
    if (!draw.seed) {
      throw conflict("El sorteo no tiene semilla registrada y no se puede ejecutar de forma verificable");
    }
    const raffle = await tx.raffle.findUnique({ where: { id: raffleId } });
    if (!raffle) throw notFound("Rifa no existe");
    if (!DRAWABLE_RAFFLE_STATUSES.includes(raffle.status as (typeof DRAWABLE_RAFFLE_STATUSES)[number])) {
      throw conflict(
        `La rifa debe estar CERRADA o EN_SORTEO para ejecutar el sorteo (estado actual: ${raffle.status})`,
      );
    }
    const blockers = await checkDrawBlockers(raffleId, tx);
    if (blockers.blocked) {
      throw conflict(`No se puede sortear: hay operaciones sin resolver — ${blockers.reasons.join("; ")}`);
    }
    // Integridad: el compromiso guardado debe corresponder a la semilla
    // guardada y al snapshot congelado; si no, algo fue alterado.
    if (createCommitment(draw.seed, draw.hashElegibles) !== draw.commitment) {
      throw conflict("El compromiso guardado no corresponde a la semilla y la lista congelada; sorteo bloqueado");
    }
    const eligible = JSON.parse(draw.eligibleSnapshot) as number[];
    if (!Array.isArray(eligible) || eligible.length !== draw.totalElegibles || eligible.length === 0) {
      throw conflict("La lista congelada de elegibles es inválida; sorteo bloqueado");
    }
    if (serializeEligible(eligible) !== draw.eligibleSnapshot) {
      throw conflict("La lista congelada de elegibles no es canónica; sorteo bloqueado");
    }
    const winnerIndex = drawWinnerIndex(draw.seed, draw.hashElegibles, eligible.length);
    const winnerNumber = eligible[winnerIndex];
    const winningTicket = await tx.ticket.findFirst({
      where: { raffleId, number: winnerNumber },
    });
    if (!winningTicket) {
      throw conflict(`El boleto ganador #${winnerNumber} no existe en la rifa; sorteo bloqueado`);
    }
    const executedAt = new Date();
    const updated = await tx.draw.update({
      where: { id: draw.id },
      data: {
        winningTicketId: winningTicket.id,
        executedAt,
        drawnById: drawnById ?? draw.drawnById ?? null,
      },
    });
    await tx.raffle.update({ where: { id: raffleId }, data: { status: "GANADOR_PUBLICADO" } });
    // El caso del ganador se abre aquí; su cierre es independiente de la
    // publicación (aclaración 2): solo se cierra con entrega registrada.
    const existingCase = await tx.winnerCase.findUnique({ where: { raffleId } });
    if (!existingCase) {
      await tx.winnerCase.create({
        data: { raffleId, winningTicketId: winningTicket.id, status: "PENDIENTE_CONTACTO" },
      });
    } else if (!existingCase.winningTicketId) {
      await tx.winnerCase.update({
        where: { id: existingCase.id },
        data: { winningTicketId: winningTicket.id },
      });
    }
    return {
      drawId: updated.id,
      raffleId,
      commitment: updated.commitment,
      seed: draw.seed,
      hashElegibles: updated.hashElegibles,
      eligibleSnapshot: updated.eligibleSnapshot,
      totalElegibles: updated.totalElegibles,
      winnerTicketId: winningTicket.id,
      winnerTicketNumber: winningTicket.number,
      winnerTicketCode: winningTicket.code,
      winnerIndex,
      algorithm: updated.algorithm,
      publishedAt: updated.createdAt,
      executedAt,
      seedRevealed: true,
    };
  });
}
