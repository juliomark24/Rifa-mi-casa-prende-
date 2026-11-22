// Job `recovery-sweep` (cada 5 min; plan §2.12, docs/jobs.md §5).
// Detecta operaciones incompletas y genera casos visibles en el panel;
// nunca duplica cobros, pedidos, boletos ni comisiones al recuperar.
//
// Hace dos cosas:
//  1. Expira solicitudes de recuperación admin/2FA vencidas (ver
//     docs/recuperacion-admin-2fa.md): solicitud PENDIENTE sin aprobar
//     en 1 h, o APROBADA con código de un solo uso vencido (15 min) →
//     EXPIRADO. Idempotente por estado: la segunda pasada no encuentra
//     nada que expirar.
//  2. Pagos confirmados sin boletos emitidos → caso de reconciliación
//     ABIERTO (plan §2.13: el cliente no se queda sin boleto; se emite
//     el boleto o se reembolsa, con registro). Idempotente: si ya existe
//     un caso ABIERTO igual (mismo pedido), no se crea otro.
//
// NOTA DE MODELO (para el coordinador): el schema v2.2 no tiene un
// modelo `RecoveryCase`; los casos de recuperación de pagos se registran
// como `ReconciliationCase` (el mismo caso del ejemplo §2.13) y quedan
// visibles en GET /api/admin/reconciliation.
import { db } from "../lib/db";
import type { JobHandler } from "../lib/jobs";

export const jobName = "recovery-sweep";

export const handler: JobHandler = async () => {
  const now = new Date();

  const expiredRequests = await db.recoveryRequest.updateMany({
    where: { status: "PENDIENTE", expiresAt: { lt: now } },
    data: { status: "EXPIRADO" },
  });
  const expiredCodes = await db.recoveryRequest.updateMany({
    where: { status: "APROBADO", resetCodeExpiresAt: { lt: now } },
    data: { status: "EXPIRADO" },
  });

  const payments = await db.payment.findMany({
    where: { status: "APROBADO" },
    include: { order: { include: { tickets: true } } },
  });
  const openCases = await db.reconciliationCase.findMany({
    where: { status: "ABIERTO" },
    select: { detail: true },
  });
  const openOrderIds = new Set(
    openCases
      .map((c) => (c.detail as { orderId?: string; type?: string } | null))
      .filter((d) => d?.type === "pago_sin_boletos" && d.orderId)
      .map((d) => (d as { orderId: string }).orderId),
  );

  let casesCreated = 0;
  let alreadyOpen = 0;
  for (const payment of payments) {
    const sold = payment.order.tickets.filter((t) => t.status === "VENDIDO").length;
    if (sold > 0) continue;
    if (openOrderIds.has(payment.orderId)) {
      alreadyOpen += 1;
      continue;
    }
    await db.reconciliationCase.create({
      data: {
        provider: payment.providerCode ?? "MANUAL_TRANSFER",
        status: "ABIERTO",
        detail: {
          type: "pago_sin_boletos",
          orderId: payment.orderId,
          orderCode: payment.order.code,
          paymentId: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          detectedBy: "recovery-sweep",
        },
        amount: payment.amount,
        currency: payment.currency,
      },
    });
    openOrderIds.add(payment.orderId);
    casesCreated += 1;
  }

  return {
    ok: true,
    recoveryRequestsExpired: expiredRequests.count + expiredCodes.count,
    reconciliationCasesCreated: casesCreated,
    reconciliationCasesAlreadyOpen: alreadyOpen,
    paymentsChecked: payments.length,
  };
};
