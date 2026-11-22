// Job `retention-sweep` (diario; plan §2.4, docs/jobs.md §5).
// Libera comisiones retenidas cuyo período de riesgo terminó y las
// mueve a saldo disponible del afiliado (RETAINED → AVAILABLE).
//
// Regla del plan §2.4: la comisión queda retenida hasta el cierre de
// la rifa o 7 días tras la confirmación, LO QUE OCURRA DESPUÉS.
// Cierre = rifa en CERRADA / FINALIZADA / GANADOR_PUBLICADO /
// EN_SORTEO, o fecha de sorteo ya pasada. Días de retención:
// Setting RETENTION_DAYS, o env, o 7 por defecto.
// Idempotente por comisión: la segunda pasada no encuentra nada que
// liberar (la comisión ya está AVAILABLE).
//
// S9-int (corrección de S6): una comisión retenida por fraude
// (`holdCommission`, AVAILABLE → RETAINED) NO se libera automáticamente
// al vencer el período mientras su caso de fraude siga abierto. El sweep
// salta las comisiones con caso de fraude abierto (REVISION / RETENIDO /
// BLOQUEADO) sobre el pedido, el afiliado o el comprador; solo la
// revisión humana (que cierra el caso a APROBADO, o lo reabre y aprueba)
// vuelve a habilitar la liberación. Las saltadas se reportan en
// `skippedFraudHold` para que el admin las vea en el JobRun.
//
// NOTA: la liberación es un cambio de estado, no un movimiento de
// dinero (el dinero ya se contabilizó al generar la comisión); por eso
// no crea asiento en el ledger. Cada liberación queda en auditoría.
import { logAudit } from "../lib/audit";
import { db } from "../lib/db";
import type { JobHandler } from "../lib/jobs";

export const jobName = "retention-sweep";

const CLOSED_RAFFLE_STATUSES = ["CERRADA", "FINALIZADA", "GANADOR_PUBLICADO", "EN_SORTEO"] as const;

export async function getRetentionDays(): Promise<number> {
  try {
    const setting = await db.setting.findUnique({ where: { key: "RETENTION_DAYS" } });
    if (setting) {
      const n = Number(setting.value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    // Sin BD disponible: cae al env.
  }
  const env = Number(process.env.RETENTION_DAYS ?? "7");
  return Number.isFinite(env) && env >= 0 ? env : 7;
}

export const handler: JobHandler = async () => {
  const now = new Date();
  const retentionDays = await getRetentionDays();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

  const retained = await db.commission.findMany({
    where: { status: "RETAINED" },
    include: { order: { include: { raffle: true } } },
  });
  const releasable: string[] = [];
  const skippedFraudHold: string[] = [];
  for (const commission of retained) {
    const riskEnded = now.getTime() - commission.createdAt.getTime() >= retentionMs;
    if (!riskEnded) continue;
    const raffle = commission.order.raffle;
    const closed =
      (CLOSED_RAFFLE_STATUSES as readonly string[]).includes(raffle.status) ||
      raffle.drawAt.getTime() <= now.getTime();
    if (!closed) continue;
    // S9-int: caso de fraude abierto sobre el pedido, el afiliado o el
    // comprador → no liberar; la revisión humana decide.
    const openFraudCase = await db.fraudCase.findFirst({
      where: {
        status: { in: ["REVISION", "RETENIDO", "BLOQUEADO"] },
        OR: [
          { entityType: "Order", entityId: commission.orderId },
          { entityType: "User", entityId: commission.affiliateId },
          { entityType: "Buyer", entityId: commission.order.buyerEmail },
        ],
      },
      select: { id: true },
    });
    if (openFraudCase) {
      skippedFraudHold.push(commission.id);
      continue;
    }
    releasable.push(commission.id);
  }

  let released = 0;
  if (releasable.length > 0) {
    const res = await db.commission.updateMany({
      where: { id: { in: releasable }, status: "RETAINED" },
      data: { status: "AVAILABLE" },
    });
    released = res.count;
    await logAudit({
      action: "affiliate.commission.released",
      entity: "Commission",
      after: { released, commissionIds: releasable, retentionDays, by: "retention-sweep" },
    });
  }
  if (skippedFraudHold.length > 0) {
    await logAudit({
      action: "affiliate.commission.release-skipped-fraud-hold",
      entity: "Commission",
      after: { skipped: skippedFraudHold.length, commissionIds: skippedFraudHold, by: "retention-sweep" },
    });
  }

  return { ok: true, released, skippedFraudHold: skippedFraudHold.length, retainedChecked: retained.length, retentionDays };
};
