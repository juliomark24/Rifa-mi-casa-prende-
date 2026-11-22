// Job `compensate-paid-commissions` (S6; plan §2.4).
// Compensa las comisiones de pedidos reembolsados que S5 dejó en revisión
// humana (`comision-pagada-reembolsada`): AVAILABLE → ADJUSTED + AJUSTE
// positivo (revierte el COMISION; el dinero no salió); PAID → ADJUSTED
// + AJUSTE NEGATIVO (saldo negativo a compensar con futuras comisiones).
// Tras compensar (o si ya no queda nada que compensar), resuelve el caso
// de conciliación. Idempotente por comisión: una compensación ya aplicada
// no se duplica (se detecta por el AJUSTE existente).
// Registrar en KNOWN_JOBS + JOB_MODULE_FILES (src/lib/jobs.ts) — lo hace
// el coordinador (S6 no toca jobs.ts).
import { compensateRefundedCommissions, resolvePaidCommissionCases } from "../lib/affiliates";
import { db, type Tx } from "../lib/db";
import { logAudit } from "../lib/audit";
import type { JobHandler, JobResult } from "../lib/jobs";

export const JOB_NAME = "compensate-paid-commissions";
export const jobName = JOB_NAME;

export type CompensateResult = JobResult & {
  casesChecked: number;
  casesResolved: number;
  compensated: number;
  negativeBalance: number;
};

export async function run(): Promise<CompensateResult> {
  const open = await db.reconciliationCase.findMany({
    where: { status: "ABIERTO" },
    select: { id: true, detail: true },
  });
  let casesResolved = 0;
  let compensated = 0;
  let negativeBalance = 0;
  for (const c of open) {
    const detail = c.detail as { kind?: string; orderId?: string } | null;
    if (detail?.kind !== "comision-pagada-reembolsada" || !detail.orderId) continue;
    const res = await db.$transaction(async (tx: Tx) => {
      const comp = await compensateRefundedCommissions(tx, detail.orderId as string, {
        reason: "compensación automática (job compensate-paid-commissions)",
      });
      const resolved = await resolvePaidCommissionCases(tx, detail.orderId as string);
      return { comp, resolved };
    });
    compensated += res.comp.compensated.length;
    negativeBalance += res.comp.compensated
      .filter((x) => x.kind === "negative-balance")
      .reduce((acc, x) => acc + x.amount, 0);
    if (res.resolved.length > 0) {
      casesResolved += res.resolved.length;
      await logAudit({
        action: "affiliate.commission.compensated",
        entity: "ReconciliationCase",
        entityId: c.id,
        after: { orderId: detail.orderId, compensated: res.comp.compensated, by: "compensate-paid-commissions" },
      });
    }
  }
  return { ok: true, casesChecked: open.length, casesResolved, compensated, negativeBalance };
}

export const handler: JobHandler = async () => run();
