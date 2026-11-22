// Bases versionadas (plan §2.18, P26).
// Cada rifa guarda la versión de sus bases que cada cliente aceptó.
// Las versiones viejas son INMUTABLES: nunca se editan ni se borran; un
// cambio crea la versión n+1 y la marca como vigente en la rifa.
// Cada compra futura vincula su TermsAcceptance (lo usa S4); si las bases
// cambian después de comprar, queda registrado qué versión aplicó a cada
// comprador.
import { badRequest, notFound } from "./errors";
import { db } from "./db";
import type { RaffleTerms, TermsAcceptance } from "../generated/prisma/client";

/** Crea la versión n+1 y la marca como vigente en la rifa (transacción). */
export async function createTermsVersion(opts: {
  raffleId: string;
  content: string;
  createdById?: string | null;
}): Promise<RaffleTerms> {
  const raffle = await db.raffle.findUnique({ where: { id: opts.raffleId } });
  if (!raffle) throw notFound("Rifa no existe");
  const last = await db.raffleTerms.findFirst({
    where: { raffleId: opts.raffleId },
    orderBy: { version: "desc" },
  });
  const version = (last?.version ?? 0) + 1;
  return db.$transaction(async (tx) => {
    const created = await tx.raffleTerms.create({
      data: {
        raffleId: opts.raffleId,
        version,
        content: opts.content,
        createdById: opts.createdById ?? null,
      },
    });
    await tx.raffle.update({
      where: { id: opts.raffleId },
      data: { termsVersionId: created.id },
    });
    return created;
  });
}

/** Versión vigente de las bases de una rifa (la que apunta termsVersionId). */
export async function getCurrentTerms(raffleId: string): Promise<RaffleTerms | null> {
  const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle?.termsVersionId) return null;
  return db.raffleTerms.findUnique({ where: { id: raffle.termsVersionId } });
}

/** Todas las versiones de una rifa, de la más nueva a la más vieja. */
export async function listTermsVersions(raffleId: string): Promise<RaffleTerms[]> {
  return db.raffleTerms.findMany({
    where: { raffleId },
    orderBy: { version: "desc" },
  });
}

/**
 * Registra que un comprador aceptó la versión vigente de las bases.
 * Idempotente: el mismo comprador + misma versión solo se registra una vez
 * (unique [raffleId, termsId, buyerEmail]).
 */
export async function recordTermsAcceptance(opts: {
  raffleId: string;
  buyerEmail: string;
  userId?: string | null;
}): Promise<TermsAcceptance> {
  const current = await getCurrentTerms(opts.raffleId);
  if (!current) {
    throw badRequest("La rifa no tiene bases vigentes para aceptar");
  }
  return db.termsAcceptance.upsert({
    where: {
      raffleId_termsId_buyerEmail: {
        raffleId: opts.raffleId,
        termsId: current.id,
        buyerEmail: opts.buyerEmail.toLowerCase(),
      },
    },
    update: {},
    create: {
      raffleId: opts.raffleId,
      termsId: current.id,
      userId: opts.userId ?? null,
      buyerEmail: opts.buyerEmail.toLowerCase(),
    },
  });
}

/**
 * La versión de las bases que aceptó un comprador (P26): si las bases
 * cambiaron después de su compra, esto devuelve la versión que le aplicó,
 * no la vigente.
 */
export async function getBuyerAcceptedTerms(
  raffleId: string,
  buyerEmail: string,
): Promise<(TermsAcceptance & { terms: RaffleTerms }) | null> {
  return db.termsAcceptance.findFirst({
    where: { raffleId, buyerEmail: buyerEmail.toLowerCase() },
    include: { terms: true },
    orderBy: { acceptedAt: "desc" },
  });
}
