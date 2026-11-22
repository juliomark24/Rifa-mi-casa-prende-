// Job `reconcile-provider` (plan §2.13, P21; contrato API § Jobs).
// Corre a diario + bajo demanda. El runner de S8 lo conecta con runJob();
// este módulo solo expone el nombre y el trabajo, sin registrar JobRun
// aquí (evita doble registro si S8 lo envuelve con runJob).
//
// NO se confía solo en los webhooks: compara los registros internos
// (pedidos, pagos, boletos, ledger) entre sí y, para los proveedores con
// API, contra su reporte. Toda diferencia genera un ReconciliationCase
// ABIERTO con su detalle (qué falta, en qué lado, montos, fechas) y una
// alerta al admin; NUNCA se corrigen registros en silencio.
//
// Controles internos (transferencia manual, sin reporte externo):
//  - pago-sin-boletos: Payment APROBADO sin pedido CONFIRMADO o sin
//    boletos VENDIDO (el cliente no se queda sin boleto: emitir o
//    reembolsar, con registro).
//  - pedido-sin-pago: Order CONFIRMADO sin ningún Payment APROBADO.
//  - monto-distinto: Order CONFIRMADO + Payment APROBADO con montos
//    diferentes.
//  - reembolso-sin-asiento: Payment REEMBOLSADO sin asiento REEMBOLSO
//    en el ledger para ese pedido.
//  - venta-sin-confirmacion: asiento VENTA en ledger cuyo pedido no está
//    CONFIRMADO (y tampoco REEMBOLSADO ni DISPUTADO: esos ya pasaron por
//    CONFIRMADO y su VENTA es historia legítima — S9-int).
//
// Proveedores con API: en Fase 1 NINGÚN gateway está operativo ni tiene
// conector de reporte implementado, así que no se inventan datos del
// proveedor: el caso se registra como NO_CONCILIABLE (detalle
// kind `no-conciliable`, con el motivo) una vez por proveedor y día, y
// el resumen del job lo refleja. Cuando un gateway se verifique de
// verdad (regla 6), su adaptador expondrá el reporte y este job lo
// comparará aquí (punto de extensión marcado abajo).
//
// Idempotente: un caso ABIERTO igual (mismo kind + pedido/proveedor +
// período) no se duplica en la siguiente pasada.
import { db } from "../lib/db";
import { logAudit } from "../lib/audit";
import { queueNotificationSafe } from "../lib/notifications";

export const JOB_NAME = "reconcile-provider";

type OpenCaseIndex = Map<string, boolean>;

function caseKey(kind: string, scope: string): string {
  return `${kind}:${scope}`;
}

async function loadOpenCases(now: Date): Promise<OpenCaseIndex> {
  const open = await db.reconciliationCase.findMany({
    where: { status: "ABIERTO" },
    select: { detail: true, provider: true },
  });
  const index: OpenCaseIndex = new Map();
  for (const c of open) {
    const d = c.detail as { kind?: string; orderId?: string; period?: string } | null;
    if (!d?.kind) continue;
    const scope = d.orderId ?? `${c.provider}:${d.period ?? ""}`;
    index.set(caseKey(d.kind, scope), true);
  }
  return index;
}

export type ReconcileResult = {
  ok: boolean;
  period: string;
  paymentsChecked: number;
  ordersChecked: number;
  ledgerEntriesChecked: number;
  casesCreated: number;
  casesAlreadyOpen: number;
  providers: Array<{ provider: string; conciliable: boolean; reason: string }>;
};

export async function run(now = new Date()): Promise<ReconcileResult> {
  const period = now.toISOString().slice(0, 10);
  const openCases = await loadOpenCases(now);
  let casesCreated = 0;
  let casesAlreadyOpen = 0;

  const openCase = async (input: {
    provider: string;
    kind: string;
    scope: string;
    detail: Record<string, unknown>;
    amount?: number | null;
    currency?: string | null;
  }) => {
    const key = caseKey(input.kind, input.scope);
    if (openCases.has(key)) {
      casesAlreadyOpen += 1;
      return;
    }
    await db.reconciliationCase.create({
      data: {
        provider: input.provider,
        period,
        status: "ABIERTO",
        detail: { kind: input.kind, ...input.detail } as never,
        amount: input.amount ?? null,
        currency: input.currency ?? null,
      },
    });
    openCases.set(key, true);
    casesCreated += 1;
  };

  // ---------------------------------------------------------- controles internos
  const payments = await db.payment.findMany({
    include: { order: { include: { tickets: true } } },
  });
  const orders = await db.order.findMany({
    include: { payments: true, tickets: true },
  });
  const salesEntries = await db.ledgerEntry.findMany({ where: { type: "VENTA" } });

  for (const payment of payments) {
    const order = payment.order;
    const sold = order.tickets.filter((t) => t.status === "VENDIDO").length;
    if (payment.status === "APROBADO" && (order.status !== "CONFIRMADO" || sold === 0)) {
      await openCase({
        provider: payment.providerCode ?? "MANUAL_TRANSFER",
        kind: "pago-sin-boletos",
        scope: order.id,
        detail: {
          orderId: order.id,
          orderCode: order.code,
          paymentId: payment.id,
          orderStatus: order.status,
          soldTickets: sold,
          detectedBy: "reconcile-provider",
        },
        amount: payment.amount,
        currency: payment.currency,
      });
    }
    if (payment.status === "REEMBOLSADO") {
      const entry = await db.ledgerEntry.findFirst({
        where: { type: "REEMBOLSO", refType: "Order", refId: order.id },
      });
      if (!entry) {
        await openCase({
          provider: payment.providerCode ?? "MANUAL_TRANSFER",
          kind: "reembolso-sin-asiento",
          scope: order.id,
          detail: {
            orderId: order.id,
            orderCode: order.code,
            paymentId: payment.id,
            detectedBy: "reconcile-provider",
          },
          amount: payment.amount,
          currency: payment.currency,
        });
      }
    }
  }

  for (const order of orders) {
    if (order.status === "CONFIRMADO") {
      const approved = order.payments.find((p) => p.status === "APROBADO");
      if (!approved) {
        await openCase({
          provider: order.payments[0]?.providerCode ?? "MANUAL_TRANSFER",
          kind: "pedido-sin-pago",
          scope: order.id,
          detail: {
            orderId: order.id,
            orderCode: order.code,
            paymentStatuses: order.payments.map((p) => p.status),
            detectedBy: "reconcile-provider",
          },
          amount: order.totalAmount,
          currency: order.currency,
        });
      } else if (approved.amount !== order.totalAmount) {
        await openCase({
          provider: approved.providerCode ?? "MANUAL_TRANSFER",
          kind: "monto-distinto",
          scope: order.id,
          detail: {
            orderId: order.id,
            orderCode: order.code,
            paymentId: approved.id,
            expectedAmount: order.totalAmount,
            receivedAmount: approved.amount,
            detectedBy: "reconcile-provider",
          },
          amount: approved.amount,
          currency: order.currency,
        });
      }
    }
  }

  const orderById = new Map(orders.map((o) => [o.id, o]));
  for (const entry of salesEntries) {
    const order = orderById.get(entry.refId);
    // S9-int (corrección del falso positivo de S6): un pedido REEMBOLSADO
    // o DISPUTADO (contracargo) ya pasó por CONFIRMADO cuando se registró
    // la VENTA; su asiento es historia legítima, no una venta sin
    // confirmación. Solo un pedido que nunca se confirmó (PENDIENTE /
    // FALLIDO / EXPIRADO) con asiento VENTA es discrepancia real.
    if (order && order.status !== "CONFIRMADO" && order.status !== "REEMBOLSADO" && order.status !== "DISPUTADO") {
      await openCase({
        provider: "MANUAL_TRANSFER",
        kind: "venta-sin-confirmacion",
        scope: order.id,
        detail: {
          orderId: order.id,
          orderCode: order.code,
          orderStatus: order.status,
          ledgerEntryId: entry.id,
          detectedBy: "reconcile-provider",
        },
        amount: entry.amount,
        currency: entry.currency,
      });
    }
  }

  // ---------------------------------------------------------- proveedores con API
  // PUNTO DE EXTENSIÓN (regla 6): cuando un gateway esté verificado de
  // verdad, su adaptador expondrá `fetchReport(period)` y aquí se
  // comparará contra pagos/pedidos/boletos internos. Hoy no existe ese
  // método en ningún adaptador: no se inventan datos del proveedor.
  const providers: ReconcileResult["providers"] = [];
  const providerRows = await db.paymentProvider.findMany();
  for (const row of providerRows) {
    if (row.code === "MANUAL_TRANSFER") continue;
    const conciliable = row.status === "OPERATIVO" && Boolean(row.credentialsRef);
    const reason = conciliable
      ? "proveedor operativo pero sin conector de reporte implementado; conciliación manual hasta implementar fetchReport en su adaptador"
      : "sin credenciales y/o no operativo (regla 6); no hay reporte del proveedor que comparar";
    providers.push({ provider: row.code, conciliable: false, reason });
    await openCase({
      provider: row.code,
      kind: "no-conciliable",
      scope: `${row.code}:${period}`,
      detail: {
        period,
        providerStatus: row.status,
        credentialsConfigured: Boolean(row.credentialsRef),
        reason,
        detectedBy: "reconcile-provider",
      },
    });
  }

  const result: ReconcileResult = {
    ok: true,
    period,
    paymentsChecked: payments.length,
    ordersChecked: orders.length,
    ledgerEntriesChecked: salesEntries.length,
    casesCreated,
    casesAlreadyOpen,
    providers,
  };

  await logAudit({
    actorId: null,
    action: "payments.reconcile",
    entity: "ReconciliationCase",
    after: result,
  });

  if (casesCreated > 0) {
    const admin = await db.user.findFirst({
      where: { role: "SUPERADMIN" },
      orderBy: { createdAt: "asc" },
    });
    if (admin) {
      await queueNotificationSafe({
        event: "alerta_sistema",
        channel: "EMAIL",
        recipient: admin.email,
        data: {
          severity: "alta",
          alertType: "conciliacion",
          message: `Conciliación ${period}: ${casesCreated} caso(s) nuevo(s) de discrepancia (ver panel admin).`,
        },
        dedupeKey: `reconciliacion:${period}`,
      });
    }
  }
  return result;
}
