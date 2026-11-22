// Motor de notificaciones (plan §2.16, §2.19; docs/jobs.md §3).
// Eventos configurables del plan, cola con reintentos y backoff,
// registro de entregas y control de duplicados (un evento = una
// notificación por destinatario y canal).
//
// REGLA DE ORO (plan §2.16): un fallo de notificación NUNCA rompe la
// compra ni las operaciones financieras. La venta sigue y la
// notificación se reintenta en segundo plano. Por eso:
//  - `queueNotificationSafe` nunca lanza (traga el error y lo registra).
//  - `dispatchPendingNotifications` nunca lanza por un envío fallido:
//    el fallo queda en la fila (attempts/lastError) y se reintenta.
//  - Sin RESEND_API_KEY, el correo queda PENDIENTE (no se marca fallido
//    ni se rompe nada): el envío espera a que se configure la clave.
//  - WhatsApp es Fase 2 (stub): el intento queda registrado como
//    NO_CONFIGURADO, sin inventar ninguna integración.
import { Prisma } from "../generated/prisma/client";
import type { NotificationChannel } from "../generated/prisma/client";
import { db } from "./db";

/** Eventos configurables del plan §2.16. */
export const NOTIFICATION_EVENTS = [
  "compra_iniciada",
  "pago_confirmado",
  "reserva_por_vencer",
  /** Aviso a las 20 h de un pedido PENDIENTE de transferencia manual (S5: expira a las 24 h). */
  "pedido_por_vencer",
  "sorteo_proximo",
  "sorteo_realizado",
  "ganador",
  "reembolso",
  "comision_afiliada",
  "retiro_afiliado",
  /** Aviso interno al admin (alerta de monitoreo §2.19). No es un evento de cliente. */
  "alerta_sistema",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Reintentos máximos antes de marcar FALLIDO (docs/jobs.md §3). */
export const MAX_NOTIFICATION_ATTEMPTS = 5;
/** Backoff en minutos tras cada intento fallido (1, 5, 15, 60, 240). */
export const NOTIFICATION_BACKOFF_MINUTES = [1, 5, 15, 60, 240];

export function backoffMs(attempts: number): number {
  const idx = Math.min(Math.max(attempts - 1, 0), NOTIFICATION_BACKOFF_MINUTES.length - 1);
  return NOTIFICATION_BACKOFF_MINUTES[idx] * 60 * 1000;
}

// ---------------------------------------------------------------- plantillas
// Plantillas por evento (español; por idioma según el país del cliente en
// Fase 2 — hoy todas en español). {{clave}} se sustituye con `data`.
const TEMPLATES: Record<NotificationEvent, { subject: string; body: string }> = {
  compra_iniciada: {
    subject: "Tu pedido {{orderCode}} está en curso — Prende Rifas",
    body: "Hola {{buyerName}}, recibimos tu pedido {{orderCode}} por {{totalAmount}} {{currency}}. Completa el pago para asegurar tus boletos.",
  },
  pago_confirmado: {
    subject: "¡Pago confirmado! Tus boletos {{orderCode}} — Prende Rifas",
    body: "Hola {{buyerName}}, tu pago de {{totalAmount}} {{currency}} fue confirmado. Pedido {{orderCode}}. Tus boletos ya son tuyos. ¡Mucha suerte!",
  },
  reserva_por_vencer: {
    subject: "Tu reserva vence pronto — Prende Rifas",
    body: "Hola {{buyerName}}, tu reserva {{reservationId}} vence en {{minutesLeft}} minutos. Completa el pago o los números volverán a estar disponibles.",
  },
  pedido_por_vencer: {
    subject: "Tu pedido {{orderCode}} vence en 4 horas — Prende Rifas",
    body: "Hola {{buyerName}}, tu pedido {{orderCode}} por {{totalAmount}} {{currency}} vence en 4 horas. Completa la transferencia o los boletos volverán a estar disponibles.",
  },
  sorteo_proximo: {
    subject: "El sorteo de {{raffleTitle}} es pronto — Prende Rifas",
    body: "Hola {{buyerName}}, el sorteo de {{raffleTitle}} es el {{drawAt}}. ¡Tus boletos ya participan!",
  },
  sorteo_realizado: {
    subject: "Sorteo realizado: {{raffleTitle}} — Prende Rifas",
    body: "El sorteo de {{raffleTitle}} ya se realizó. Revisa si tu boleto ganó en la página de resultados.",
  },
  ganador: {
    subject: "¡GANASTE en {{raffleTitle}}! — Prende Rifas",
    body: "¡Felicidades {{buyerName}}! Tu boleto {{ticketNumber}} ganó en {{raffleTitle}}. Te contactaremos para coordinar la entrega del premio.",
  },
  reembolso: {
    subject: "Tu reembolso fue procesado — Prende Rifas",
    body: "Hola {{buyerName}}, tu reembolso de {{totalAmount}} {{currency}} del pedido {{orderCode}} fue procesado.",
  },
  comision_afiliada: {
    subject: "Nueva comisión: {{totalAmount}} {{currency}} — Prende Rifas",
    body: "Hola {{affiliateName}}, ganaste una comisión de {{totalAmount}} {{currency}} por la venta del pedido {{orderCode}}. Queda retenida durante el período de riesgo.",
  },
  retiro_afiliado: {
    subject: "Tu retiro cambió de estado: {{status}} — Prende Rifas",
    body: "Hola {{affiliateName}}, tu solicitud de retiro de {{totalAmount}} {{currency}} ahora está en estado {{status}}.",
  },
  alerta_sistema: {
    subject: "[Prende Rifas] Alerta {{severity}}: {{alertType}}",
    body: "Alerta del sistema ({{severity}}): {{message}}",
  },
};

export function renderTemplate(
  event: NotificationEvent,
  data: Record<string, unknown>,
): { subject: string; body: string } {
  const tpl = TEMPLATES[event];
  const render = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
      const v = data[key];
      return v === undefined || v === null ? "" : String(v);
    });
  return { subject: render(tpl.subject), body: render(tpl.body) };
}

// ---------------------------------------------------------------- envío email
export type EmailSender = (args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<{ ok: boolean; error?: string }>;

/** Envío real por Resend (fetch directo, sin SDK — sin dependencias nuevas). */
export const resendEmailSender: EmailSender = async ({ to, subject, html, text }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_NO_CONFIGURADO" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? "Prende Rifas <notificaciones@prenderifas.do>",
        to: [to],
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `Resend HTTP ${res.status}: ${detail.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ---------------------------------------------------------------- cola
export type EnqueueInput = {
  event: NotificationEvent;
  channel: NotificationChannel;
  recipient: string; // email o teléfono
  /** Datos para la plantilla (se guardan en payload). */
  data?: Record<string, unknown>;
  /**
   * Clave de dedupe de la ocurrencia del evento (ej. `pago:ORD-123`).
   * Sin ella, cada llamada encola una notificación nueva.
   */
  dedupeKey?: string;
};

function payloadOf(row: { payload: unknown }): Record<string, unknown> {
  if (row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)) {
    return row.payload as Record<string, unknown>;
  }
  return {};
}

/**
 * Encola una notificación (PENDIENTE). Dedupe: si ya existe una
 * notificación con el mismo (evento, destinatario, canal) y la misma
 * `dedupeKey`, devuelve la existente sin crear otra.
 */
export async function enqueueNotification(input: EnqueueInput) {
  const payload: Record<string, unknown> = { ...(input.data ?? {}) };
  if (input.dedupeKey) payload.dedupeKey = input.dedupeKey;
  if (input.dedupeKey) {
    const candidates = await db.notification.findMany({
      where: { event: input.event, recipient: input.recipient, channel: input.channel },
      orderBy: { createdAt: "asc" },
    });
    const existing = candidates.find((c) => payloadOf(c).dedupeKey === input.dedupeKey);
    if (existing) return existing;
  }
  return db.notification.create({
    data: {
      event: input.event,
      channel: input.channel,
      recipient: input.recipient,
      status: "PENDIENTE",
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

/**
 * Variante que NUNCA lanza: si encolar falla (BD caída, datos malos),
 * registra el error y devuelve null. Es la que deben usar los flujos
 * de compra y financieros (regla de oro §2.16).
 */
export async function queueNotificationSafe(
  input: EnqueueInput,
): Promise<Awaited<ReturnType<typeof enqueueNotification>> | null> {
  try {
    return await enqueueNotification(input);
  } catch (err) {
    console.error("[notifications] no se pudo encolar (la operación sigue):", err);
    return null;
  }
}

// ---------------------------------------------------------------- despacho
export type DispatchOptions = {
  /** Máximo de notificaciones a procesar en esta pasada. */
  limit?: number;
  /** Ignora el backoff (para reintentos manuales y tests). */
  force?: boolean;
  /** Sender inyectable (tests / scripts). Por defecto Resend. */
  emailSender?: EmailSender;
  /** Reloj inyectable (tests). */
  now?: Date;
};

export type DispatchResult = {
  processed: number;
  sent: number;
  delivered: number;
  failed: number;
  skippedNoConfig: number;
  pending: number;
};

/** ¿Está vencido el backoff para reintentar esta notificación? */
function isDue(row: { attempts: number; updatedAt: Date }, now: Date): boolean {
  if (row.attempts === 0) return true;
  return now.getTime() - row.updatedAt.getTime() >= backoffMs(row.attempts);
}

/**
 * Despacha UNA notificación PENDIENTE. Nunca lanza por un fallo de
 * envío: el fallo queda registrado en la fila (attempts/lastError).
 * Devuelve la fila actualizada (o null si no estaba PENDIENTE).
 */
export async function dispatchNotification(
  id: string,
  opts: DispatchOptions = {},
) {
  const now = opts.now ?? new Date();
  const row = await db.notification.findUnique({ where: { id } });
  if (!row || row.status !== "PENDIENTE") return row;
  if (!opts.force && !isDue(row, now)) return row;

  const data = payloadOf(row);
  const { subject, body } = renderTemplate(row.event as NotificationEvent, data);

  // Notificación interna (en la web): queda registrada al guardarla en
  // BD; marcar ENTREGADO de inmediato (ya es visible en el panel).
  if (row.channel === "WEB") {
    return db.notification.update({
      where: { id },
      data: { status: "ENTREGADO", attempts: row.attempts + 1, sentAt: now },
    });
  }

  // WhatsApp / SMS: Fase 2 (plan §2.16). Stub: se registra el intento
  // como NO_CONFIGURADO y no se reintenta (no hay integración que llamar).
  if (row.channel === "WHATSAPP" || row.channel === "SMS") {
    const channelName = row.channel === "WHATSAPP" ? "WhatsApp Business API" : "SMS";
    return db.notification.update({
      where: { id },
      data: {
        status: "FALLIDO",
        attempts: row.attempts + 1,
        lastError: `${row.channel}_NO_CONFIGURADO: ${channelName} es Fase 2 (plan §2.16); sin integración configurada`,
      },
    });
  }

  // EMAIL por Resend. Sin clave, queda PENDIENTE sin contar intento:
  // el envío espera a que el dueño configure RESEND_API_KEY.
  if (!process.env.RESEND_API_KEY) {
    return row;
  }
  const sender = opts.emailSender ?? resendEmailSender;
  const result = await sender({
    to: row.recipient,
    subject,
    html: `<p>${body.replace(/\n/g, "<br>")}</p>`,
    text: body,
  });
  if (result.ok) {
    return db.notification.update({
      where: { id },
      data: { status: "ENVIADO", attempts: row.attempts + 1, sentAt: now, lastError: null },
    });
  }
  const attempts = row.attempts + 1;
  return db.notification.update({
    where: { id },
    data: {
      status: attempts >= MAX_NOTIFICATION_ATTEMPTS ? "FALLIDO" : "PENDIENTE",
      attempts,
      lastError: result.error ?? "Error desconocido enviando el correo",
    },
  });
}

/** Despacha la cola PENDIENTE (una pasada del job `notification-dispatch`). */
export async function dispatchPendingNotifications(
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const limit = opts.limit ?? 50;
  const pending = await db.notification.findMany({
    where: { status: "PENDIENTE" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const result: DispatchResult = {
    processed: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    skippedNoConfig: 0,
    pending: pending.length,
  };
  for (const row of pending) {
    const before = row.status;
    let updated;
    try {
      updated = await dispatchNotification(row.id, opts);
    } catch (err) {
      // Un error inesperado del despacho (BD, bug) no tumba la cola:
      // se registra en la fila y se sigue con la siguiente.
      const attempts = row.attempts + 1;
      console.error("[notifications] error despachando", row.id, err);
      updated = await db.notification.update({
        where: { id: row.id },
        data: {
          status: attempts >= MAX_NOTIFICATION_ATTEMPTS ? "FALLIDO" : "PENDIENTE",
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
        },
      });
    }
    result.processed += 1;
    if (!updated || updated.status === before) {
      if (updated?.channel === "EMAIL" && !process.env.RESEND_API_KEY) {
        result.skippedNoConfig += 1;
      }
      continue;
    }
    if (updated.status === "ENVIADO") result.sent += 1;
    else if (updated.status === "ENTREGADO") result.delivered += 1;
    else if (updated.status === "FALLIDO") result.failed += 1;
  }
  return result;
}

/** Resumen de la cola para el panel admin / health. */
export async function getNotificationQueueStats() {
  const [pending, sent, delivered, failed] = await Promise.all([
    db.notification.count({ where: { status: "PENDIENTE" } }),
    db.notification.count({ where: { status: "ENVIADO" } }),
    db.notification.count({ where: { status: "ENTREGADO" } }),
    db.notification.count({ where: { status: "FALLIDO" } }),
  ]);
  const lastFailed = await db.notification.findFirst({
    where: { status: "FALLIDO" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, event: true, channel: true, recipient: true, lastError: true, updatedAt: true },
  });
  return { pending, sent, delivered, failed, lastFailed };
}
