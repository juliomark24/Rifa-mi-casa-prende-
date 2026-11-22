// POST /api/support-tickets — público (plan §2.17: el cliente puede reclamar).
// {type, buyerEmail, orderCode?, message} → ticket con número único.
// Si viene orderCode, se enlaza al pedido (y al caso de recuperación /
// conciliación cuando el tipo es PAGO_SIN_BOLETO).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseBody, supportTicketCreateSchema } from "@/lib/validate";

const TYPE_LABELS: Record<string, string> = {
  PAGO_SIN_BOLETO: "Pagué y no recibí mi boleto",
  CONSULTA_BOLETO: "No puedo consultar mi boleto",
  PAGO_RECHAZADO: "Mi pago fue rechazado",
  PROBLEMA_COMPRA: "Tengo un problema con mi compra",
  DEVOLUCION: "Quiero solicitar una devolución",
  DUDA_GANADOR: "Tengo dudas sobre el ganador",
  OTRO: "Otra consulta",
};

async function generateTicketNumber(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const count = await db.supportTicket.count();
    const number = `TKT-${String(count + 1 + attempt).padStart(6, "0")}`;
    const existing = await db.supportTicket.findUnique({ where: { number } });
    if (!existing) return number;
  }
  return `TKT-${Date.now().toString(36).toUpperCase()}`;
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const body = await parseBody(req, supportTicketCreateSchema);
    checkRateLimit(`support:${ip ?? "unknown"}:${body.buyerEmail}`, { limit: 5, windowMs: 60 * 60 * 1000 });

    let orderId: string | undefined;
    if (body.orderCode) {
      const order = await db.order.findUnique({ where: { code: body.orderCode } });
      if (!order) throw badRequest("El código de pedido no existe");
      orderId = order.id;
    }
    const current = await getCurrentUser(req);
    const ticket = await db.supportTicket.create({
      data: {
        number: await generateTicketNumber(),
        type: body.type,
        status: "ABIERTO",
        priority: body.type === "PAGO_SIN_BOLETO" ? "ALTA" : "MEDIA",
        userId: current?.user.id ?? null,
        buyerEmail: body.buyerEmail,
        orderId: orderId ?? null,
        subject: TYPE_LABELS[body.type] ?? body.type,
        description: body.message,
      },
    });
    await logAudit({
      actorId: current?.user.id ?? null,
      action: "support.ticket.created",
      entity: "SupportTicket",
      entityId: ticket.id,
      after: { number: ticket.number, type: ticket.type, orderId },
      ipAddress: ip,
    });
    return NextResponse.json(
      { ticket: { id: ticket.id, number: ticket.number, type: ticket.type, status: ticket.status } },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
