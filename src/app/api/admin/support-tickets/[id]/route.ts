// PATCH /api/admin/support-tickets/[id] — gestión de un ticket.
// Cuerpo estandarizado: {status, assignee?, note?}
// assignee = id de usuario admin responsable (owner). RESUELTO/CERRADO
// marca resolvedAt; reabrir lo limpia. La nota queda en auditoría.
//
// Transiciones permitidas (§2.17; flujo normal ABIERTO → EN_REVISION
// → ESPERANDO_CLIENTE → RESUELTO → CERRADO, con reapertura).
// Se permiten saltos hacia adelante (un admin puede resolver un ticket
// trivial sin pasarlo por EN_REVISION — lo exige el test de contrato
// preexistente); lo que NO se permite es resolver o reabrir un ticket
// CERRADO sin reabrirlo antes, ni sacar un RESUELTO a ESPERANDO_CLIENTE.
// Una transición no permitida responde 409. Cada cambio queda en
// auditoría con actor y fecha. La respuesta incluye el contexto del
// ticket (pedido, pago y boletos enlazados) para que el agente no tenga
// que buscar en varios sitios (§2.17), además del plazo (dueAt).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, conflict, errorResponse } from "@/lib/errors";
import { supportTicketDueAt, SUPPORT_SLA_HOURS } from "@/lib/monitoring";
import { parseBody, supportTicketPatchSchema } from "@/lib/validate";

type TicketStatus = "ABIERTO" | "EN_REVISION" | "ESPERANDO_CLIENTE" | "RESUELTO" | "CERRADO";

const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  ABIERTO: ["EN_REVISION", "ESPERANDO_CLIENTE", "RESUELTO", "CERRADO"],
  EN_REVISION: ["ESPERANDO_CLIENTE", "RESUELTO", "CERRADO", "ABIERTO"],
  ESPERANDO_CLIENTE: ["EN_REVISION", "RESUELTO", "CERRADO", "ABIERTO"],
  RESUELTO: ["CERRADO", "ABIERTO", "EN_REVISION"],
  CERRADO: ["ABIERTO", "EN_REVISION"],
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "support.manage");
    const body = await parseBody(req, supportTicketPatchSchema);
    const before = await db.supportTicket.findUnique({ where: { id } });
    if (!before) return NextResponse.json({ error: "Ticket no existe" }, { status: 404 });

    const from = before.status as TicketStatus;
    const to = body.status as TicketStatus;
    if (to !== from && !ALLOWED_TRANSITIONS[from].includes(to)) {
      throw conflict(`Transición de ticket no permitida: ${from} → ${to}`);
    }

    let ownerId = before.ownerId;
    if (body.assignee !== undefined) {
      if (body.assignee === null) {
        ownerId = null;
      } else {
        const assignee = await db.user.findUnique({ where: { id: body.assignee } });
        if (!assignee) throw badRequest("El responsable asignado no existe");
        ownerId = assignee.id;
      }
    }
    const resolved = body.status === "RESUELTO" || body.status === "CERRADO";
    const updated = await db.supportTicket.update({
      where: { id },
      data: {
        status: body.status,
        ownerId,
        resolvedAt: resolved ? (before.resolvedAt ?? new Date()) : null,
      },
    });
    await logAudit({
      actorId: user.id,
      action: "support.ticket.update",
      entity: "SupportTicket",
      entityId: id,
      before: { status: before.status, ownerId: before.ownerId },
      after: { status: body.status, ownerId, note: body.note ?? null },
      ipAddress: getClientIp(req),
    });

    // Contexto enlazado (§2.17): pedido, pago y boletos del ticket.
    let context: { order: unknown; payments: unknown; tickets: unknown } | null = null;
    if (updated.orderId) {
      const order = await db.order.findUnique({
        where: { id: updated.orderId },
        include: {
          payments: true,
          tickets: { select: { id: true, number: true, code: true, status: true } },
        },
      });
      if (order) {
        context = { order, payments: order.payments, tickets: order.tickets };
      }
    }
    return NextResponse.json({
      data: {
        ...updated,
        slaHours: SUPPORT_SLA_HOURS[updated.priority],
        dueAt: supportTicketDueAt(updated).toISOString(),
        context,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
