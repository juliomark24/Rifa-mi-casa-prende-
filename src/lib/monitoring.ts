// Monitoreo y alertas (plan §2.19) + métricas de soporte (§2.17).
// El sistema detecta que algo está mal antes de que el cliente se queje:
// `checkAlerts()` evalúa las 10 alertas del plan a partir del estado
// real (BD, colas, jobs, backups). `getSystemHealth()` alimenta
// GET /api/admin/health. Las alertas se registran en auditoría y las de
// severidad alta se notifican al admin por email (si está configurado)
// a través del motor de notificaciones — nunca lanzan.
import { Prisma } from "../generated/prisma/client";
import type { SupportPriority } from "../generated/prisma/client";
import { logAudit } from "./audit";
import { db } from "./db";
import { queueNotificationSafe } from "./notifications";

export type AlertSeverity = "alta" | "media";

export type Alert = {
  type: string;
  severity: AlertSeverity;
  message: string;
  count?: number;
  details?: unknown;
  detectedAt: Date;
};

/** Las 10 alertas del plan §2.19. */
export const ALERT_TYPES = [
  "pasarela_caida",
  "webhooks_retrasados",
  "pagos_sin_boletos",
  "reservas_sin_liberar",
  "errores_bd",
  "ventas_sin_actualizar",
  "sorteos_proximos_sin_condiciones",
  "backups_fallidos",
  "aumento_anormal_errores",
  "servidor_sin_capacidad",
] as const;

/** Umbrales (configurables aquí; en Fase 2, por Setting del panel). */
export const ALERT_THRESHOLDS = {
  /** Minutos sin liberar una reserva vencida antes de alertar. */
  reservationStaleMinutes: 5,
  /** Minutos sin procesar un webhook antes de alertar. */
  webhookStaleMinutes: 15,
  /** Horas antes del sorteo en las que se exige todo resuelto. */
  drawSoonHours: 72,
  /** Horas sin backup verificado antes de alertar. */
  backupMaxAgeHours: 26,
  /** Errores (jobs + notificaciones fallidas) en 1 h para "aumento anormal". */
  abnormalErrorsPerHour: 10,
  /** Notificaciones pendientes para alertar de capacidad de cola. */
  queueCapacityPending: 500,
} as const;

/** Plazo de resolución (SLA) de un ticket de soporte, por prioridad. */
export const SUPPORT_SLA_HOURS: Record<SupportPriority, number> = {
  URGENTE: 8,
  ALTA: 24,
  MEDIA: 72,
  BAJA: 120,
};

export function supportTicketDueAt(ticket: { createdAt: Date; priority: SupportPriority }): Date {
  return new Date(ticket.createdAt.getTime() + SUPPORT_SLA_HOURS[ticket.priority] * 60 * 60 * 1000);
}

/** Métricas de soporte del plan §2.17 (GET /api/admin/support-tickets/stats). */
export async function getSupportStats() {
  const [total, byStatusRows, byTypeRows, resolved] = await Promise.all([
    db.supportTicket.count(),
    db.supportTicket.groupBy({ by: ["status"], _count: { _all: true } }),
    db.supportTicket.groupBy({ by: ["type"], _count: { _all: true } }),
    db.supportTicket.findMany({
      where: { status: { in: ["RESUELTO", "CERRADO"] }, resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true },
    }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const r of byStatusRows) byStatus[r.status] = r._count._all;
  const byType: Record<string, number> = {};
  for (const r of byTypeRows) byType[r.type] = r._count._all;
  const open =
    (byStatus.ABIERTO ?? 0) + (byStatus.EN_REVISION ?? 0) + (byStatus.ESPERANDO_CLIENTE ?? 0);
  const resolutionHours = resolved
    .filter((t) => t.resolvedAt)
    .map((t) => (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 3_600_000);
  const avgResolutionHours =
    resolutionHours.length > 0
      ? Math.round((resolutionHours.reduce((a, b) => a + b, 0) / resolutionHours.length) * 100) / 100
      : null;
  return { total, open, byStatus, byType, resolvedCount: resolved.length, avgResolutionHours };
}

// ---------------------------------------------------------------- alertas
async function countPaymentsWithoutTickets(): Promise<number> {
  const payments = await db.payment.findMany({
    where: { status: "APROBADO" },
    include: { order: { include: { tickets: true } } },
  });
  return payments.filter(
    (p) => p.order.tickets.filter((t) => t.status === "VENDIDO").length === 0,
  ).length;
}

/**
 * Evalúa las 10 alertas del plan §2.19 a partir del estado real.
 * Si la BD no responde, devuelve solo `errores_bd` (no lanza).
 */
export async function checkAlerts(now: Date = new Date()): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const detectedAt = now;
  let dbOk = true;
  try {
    await db.$queryRaw(Prisma.sql`SELECT 1`);
  } catch {
    dbOk = false;
    alerts.push({
      type: "errores_bd",
      severity: "alta",
      message: "La base de datos no responde",
      detectedAt,
    });
    return alerts;
  }
  void dbOk;

  // 1. Pasarela caída: ningún proveedor OPERATIVO.
  const operativeProviders = await db.paymentProvider.count({ where: { status: "OPERATIVO" } });
  if (operativeProviders === 0) {
    alerts.push({
      type: "pasarela_caida",
      severity: "alta",
      message: "Ningún proveedor de pago está OPERATIVO",
      detectedAt,
    });
  }

  // 2. Webhooks retrasados: sin procesar desde hace más de 15 min.
  const staleWebhooks = await db.webhookEvent.count({
    where: {
      processedAt: null,
      createdAt: { lt: new Date(now.getTime() - ALERT_THRESHOLDS.webhookStaleMinutes * 60 * 1000) },
    },
  });
  if (staleWebhooks > 0) {
    alerts.push({
      type: "webhooks_retrasados",
      severity: "alta",
      message: `${staleWebhooks} webhook(s) sin procesar desde hace más de ${ALERT_THRESHOLDS.webhookStaleMinutes} minutos`,
      count: staleWebhooks,
      detectedAt,
    });
  }

  // 3. Pagos sin boletos (pago confirmado, cero boletos vendidos).
  const paymentsWithoutTickets = await countPaymentsWithoutTickets();
  if (paymentsWithoutTickets > 0) {
    alerts.push({
      type: "pagos_sin_boletos",
      severity: "alta",
      message: `${paymentsWithoutTickets} pago(s) confirmado(s) sin boletos emitidos`,
      count: paymentsWithoutTickets,
      detectedAt,
    });
  }

  // 4. Reservas sin liberar: vencidas hace más de 5 min y aún ACTIVAS.
  const staleReservations = await db.reservation.count({
    where: {
      status: "ACTIVA",
      expiresAt: { lt: new Date(now.getTime() - ALERT_THRESHOLDS.reservationStaleMinutes * 60 * 1000) },
    },
  });
  if (staleReservations > 0) {
    alerts.push({
      type: "reservas_sin_liberar",
      severity: "alta",
      message: `${staleReservations} reserva(s) vencida(s) sin liberar desde hace más de ${ALERT_THRESHOLDS.reservationStaleMinutes} minutos`,
      count: staleReservations,
      detectedAt,
    });
  }

  // 6. Ventas sin actualizar: pedido CONFIRMADO con boletos aún RESERVADO.
  const confirmedOrders = await db.order.findMany({
    where: { status: "CONFIRMADO" },
    include: { tickets: true },
  });
  const staleSales = confirmedOrders.filter((o) =>
    o.tickets.some((t) => t.status === "RESERVADO"),
  ).length;
  if (staleSales > 0) {
    alerts.push({
      type: "ventas_sin_actualizar",
      severity: "media",
      message: `${staleSales} pedido(s) confirmado(s) con boletos aún reservados (no vendidos)`,
      count: staleSales,
      detectedAt,
    });
  }

  // 7. Sorteos próximos sin condiciones: sorteo en ≤72 h con pedidos
  // pendientes o reservas activas sin resolver (bloquea el sorteo, §2.5).
  const soon = new Date(now.getTime() + ALERT_THRESHOLDS.drawSoonHours * 60 * 60 * 1000);
  const upcoming = await db.raffle.findMany({
    where: { drawAt: { lte: soon, gte: now }, status: { in: ["ACTIVA", "PROGRAMADA"] } },
    include: {
      orders: { where: { status: "PENDIENTE" }, select: { id: true } },
      reservations: { where: { status: "ACTIVA" }, select: { id: true } },
    },
  });
  const blockedDraws = upcoming.filter((r) => r.orders.length > 0 || r.reservations.length > 0);
  if (blockedDraws.length > 0) {
    alerts.push({
      type: "sorteos_proximos_sin_condiciones",
      severity: "alta",
      message: `${blockedDraws.length} sorteo(s) en menos de ${ALERT_THRESHOLDS.drawSoonHours} h con pedidos pendientes o reservas activas`,
      count: blockedDraws.length,
      details: blockedDraws.map((r) => ({ raffleId: r.id, title: r.title, drawAt: r.drawAt })),
      detectedAt,
    });
  }

  // 8. Backups fallidos: último backup-daily FAILED, o sin backup
  // verificado en las últimas 26 h.
  const lastBackup = await db.jobRun.findFirst({
    where: { job: "backup-daily" },
    orderBy: { startedAt: "desc" },
  });
  const lastBackupOk =
    lastBackup?.status === "COMPLETED" &&
    lastBackup.finishedAt !== null &&
    lastBackup.finishedAt.getTime() > now.getTime() - ALERT_THRESHOLDS.backupMaxAgeHours * 3_600_000;
  if (lastBackup?.status === "FAILED") {
    alerts.push({
      type: "backups_fallidos",
      severity: "alta",
      message: `El último backup diario falló: ${lastBackup.error ?? "sin detalle"}`,
      detectedAt,
    });
  } else if (!lastBackupOk) {
    alerts.push({
      type: "backups_fallidos",
      severity: "media",
      message: `Sin backup verificado en las últimas ${ALERT_THRESHOLDS.backupMaxAgeHours} h`,
      detectedAt,
    });
  }

  // 9. Aumento anormal de errores: jobs + notificaciones fallidas en 1 h.
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const [failedJobs, failedNotifications] = await Promise.all([
    db.jobRun.count({ where: { status: "FAILED", startedAt: { gte: oneHourAgo } } }),
    db.notification.count({ where: { status: "FALLIDO", updatedAt: { gte: oneHourAgo } } }),
  ]);
  const errorsLastHour = failedJobs + failedNotifications;
  if (errorsLastHour >= ALERT_THRESHOLDS.abnormalErrorsPerHour) {
    alerts.push({
      type: "aumento_anormal_errores",
      severity: "alta",
      message: `${errorsLastHour} errores en la última hora (jobs fallidos: ${failedJobs}, notificaciones fallidas: ${failedNotifications})`,
      count: errorsLastHour,
      detectedAt,
    });
  }

  // 10. Servidor sin capacidad: cola de notificaciones desbordada.
  // (Proxy MVP: no hay métricas de CPU/memoria del host; la cola
  // pendiente es la señal observable de que el servidor no da abasto.)
  const pendingNotifications = await db.notification.count({ where: { status: "PENDIENTE" } });
  if (pendingNotifications >= ALERT_THRESHOLDS.queueCapacityPending) {
    alerts.push({
      type: "servidor_sin_capacidad",
      severity: "media",
      message: `${pendingNotifications} notificaciones pendientes en cola (umbral ${ALERT_THRESHOLDS.queueCapacityPending})`,
      count: pendingNotifications,
      detectedAt,
    });
  }

  return alerts;
}

/** Email del admin para alertas: env o el primer SUPERADMIN. */
export async function getAdminAlertEmail(): Promise<string | null> {
  if (process.env.ADMIN_EMAIL) return process.env.ADMIN_EMAIL;
  const admin = await db.user.findFirst({
    where: { role: "SUPERADMIN" },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
  return admin?.email ?? null;
}

/**
 * Evalúa las alertas, las registra en auditoría y notifica al admin
 * (email, vía el motor de notificaciones) las de severidad alta.
 * Nunca lanza: un fallo de monitoreo no rompe nada.
 */
export async function evaluateAndRecordAlerts(now: Date = new Date()): Promise<Alert[]> {
  let alerts: Alert[];
  try {
    alerts = await checkAlerts(now);
  } catch (err) {
    console.error("[monitoring] checkAlerts falló:", err);
    return [];
  }
  for (const alert of alerts) {
    await logAudit({
      action: "monitoring.alert",
      entity: "Alert",
      entityId: alert.type,
      after: { type: alert.type, severity: alert.severity, message: alert.message, count: alert.count ?? null },
    });
    if (alert.severity === "alta") {
      try {
        const email = await getAdminAlertEmail();
        if (email) {
          await queueNotificationSafe({
            event: "alerta_sistema",
            channel: "EMAIL",
            recipient: email,
            data: { alertType: alert.type, severity: alert.severity, message: alert.message },
            dedupeKey: `alerta:${alert.type}:${now.toISOString().slice(0, 13)}`,
          });
        }
      } catch {
        // La alerta ya quedó en auditoría; el aviso es secundario.
      }
    }
  }
  return alerts;
}

// ---------------------------------------------------------------- salud
export type SystemHealth = {
  status: "ok" | "degraded" | "down";
  database: "ok" | "down";
  queues: { notifications: { pending: number; failed: number; sent: number; delivered: number } };
  jobs: Record<string, { lastRun: string | null; status: string | null; error?: string | null }>;
  lastBackupAt: string | null;
  lastBackupVerified: boolean;
  recentErrors: Array<{ type: string; message: string; at: string }>;
  alerts: Alert[];
  generatedAt: string;
};

/** Jobs que el panel de salud muestra (ver src/lib/jobs.ts). */
export const MONITORED_JOBS = [
  "release-expired-reservations",
  "reconcile-provider",
  "notification-dispatch",
  "backup-daily",
  "recovery-sweep",
  "retention-sweep",
] as const;

export async function getSystemHealth(now: Date = new Date()): Promise<SystemHealth> {
  const generatedAt = now.toISOString();
  let database: "ok" | "down" = "ok";
  try {
    await db.$queryRaw(Prisma.sql`SELECT 1`);
  } catch {
    database = "down";
  }

  const emptyQueues = { pending: 0, failed: 0, sent: 0, delivered: 0 };
  const jobs: SystemHealth["jobs"] = {};
  let lastBackupAt: string | null = null;
  let lastBackupVerified = false;
  let recentErrors: SystemHealth["recentErrors"] = [];
  let alerts: Alert[] = [];

  if (database === "ok") {
    try {
      const [pending, failed, sent, delivered] = await Promise.all([
        db.notification.count({ where: { status: "PENDIENTE" } }),
        db.notification.count({ where: { status: "FALLIDO" } }),
        db.notification.count({ where: { status: "ENVIADO" } }),
        db.notification.count({ where: { status: "ENTREGADO" } }),
      ]);
      const queues = { pending, failed, sent, delivered };
      for (const name of MONITORED_JOBS) {
        const last = await db.jobRun.findFirst({
          where: { job: name },
          orderBy: { startedAt: "desc" },
        });
        jobs[name] = {
          lastRun: last?.startedAt.toISOString() ?? null,
          status: last?.status ?? null,
          error: last?.error ?? null,
        };
      }
      const lastBackup = await db.jobRun.findFirst({
        where: { job: "backup-daily", status: "COMPLETED" },
        orderBy: { startedAt: "desc" },
      });
      lastBackupAt = lastBackup?.finishedAt?.toISOString() ?? lastBackup?.startedAt.toISOString() ?? null;
      const result = lastBackup?.result as { verified?: boolean; mode?: string } | null;
      lastBackupVerified = result?.verified === true;
      const [failedRuns, failedNotifs] = await Promise.all([
        db.jobRun.findMany({
          where: { status: "FAILED" },
          orderBy: { startedAt: "desc" },
          take: 5,
          select: { job: true, error: true, startedAt: true },
        }),
        db.notification.findMany({
          where: { status: "FALLIDO" },
          orderBy: { updatedAt: "desc" },
          take: 5,
          select: { event: true, lastError: true, updatedAt: true },
        }),
      ]);
      recentErrors = [
        ...failedRuns.map((r) => ({ type: `job:${r.job}`, message: r.error ?? "falló", at: r.startedAt.toISOString() })),
        ...failedNotifs.map((n) => ({ type: `notificacion:${n.event}`, message: n.lastError ?? "falló", at: n.updatedAt.toISOString() })),
      ];
      alerts = await checkAlerts(now);
      return {
        status: alerts.some((a) => a.severity === "alta") ? "degraded" : "ok",
        database,
        queues: { notifications: queues },
        jobs,
        lastBackupAt,
        lastBackupVerified,
        recentErrors,
        alerts,
        generatedAt,
      };
    } catch (err) {
      console.error("[monitoring] health parcial:", err);
    }
  }

  // BD caída (o error leyendo el resto): estado degradado/down con lo que haya.
  try {
    alerts = await checkAlerts(now);
  } catch {
    alerts = [{ type: "errores_bd", severity: "alta", message: "La base de datos no responde", detectedAt: now }];
  }
  return {
    status: database === "down" ? "down" : "degraded",
    database,
    queues: { notifications: emptyQueues },
    jobs,
    lastBackupAt,
    lastBackupVerified,
    recentErrors,
    alerts,
    generatedAt,
  };
}
