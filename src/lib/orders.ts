// Pedidos (plan §2.11, §2.12, §2.4, §2.18).
// Cadena: Cliente → Pedido → Pago → Boletos → Comisiones → Ledger.
// Un pedido es independiente de sus boletos y de su pago.
//  - Crear pedido = Order PENDIENTE + Payment PENDIENTE + tickets
//    RESERVADO, todo en una transacción, con clave de idempotencia.
//  - Repetir la misma Idempotency-Key devuelve el mismo pedido sin
//    efectos duplicados (P20): ni segundo cobro, ni segundo pedido,
//    ni boletos duplicados.
//  - Compra invitada (sin registro obligatorio).
//  - Atribución de afiliado: ventana 7 días, último clic; auto-referido
//    bloqueado (mismo usuario/email/teléfono que el afiliado).
//  - Aceptación de bases: se vincula TermsAcceptance con la versión
//    vigente de la rifa en el momento de la compra.
//  - Pago parcial: MANUAL_TRANSFER no lo permite; un pago por menos del
//    total nunca se registra como venta completa (la confirmación es S5
//    y debe rechazar/marcar el parcial, no confirmar el pedido).
import crypto from "node:crypto";
import { z } from "zod";
import type { OrderStatus, PaymentMethodCode } from "../generated/prisma/client";
import { db, type Tx } from "./db";
import { logAudit } from "./audit";
import { ApiError, conflict, notFound, notConfigured } from "./errors";
import {
  getActiveReservation,
  reserveNumbersTx,
} from "./reservations";
import { isBlockedFromPurchasing } from "./fraud";

export const purchaseSchema = z.object({
  reservationId: z.string().trim().max(64).optional(),
  numbers: z.array(z.number().int()).min(1).max(100).optional(),
  quantity: z.number().int().min(1).max(100).optional(),
  paymentMethodCode: z.enum(["MANUAL_TRANSFER", "PAYPAL", "AZUL_CARD", "CARDNET_CARD"]),
  affiliateCode: z.string().trim().max(32).optional(),
  buyerName: z.string().trim().min(2, "El nombre es obligatorio").max(120),
  buyerEmail: z.string().trim().toLowerCase().email("Email inválido"),
  buyerPhone: z.string().trim().max(30).optional(),
  // La compra implica aceptar las bases vigentes; si viene false explícito se rechaza.
  acceptTerms: z.boolean().optional(),
});

export type PurchaseInput = z.infer<typeof purchaseSchema>;

/** Máquina de estados del pedido (plan §2.11). */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDIENTE: ["CONFIRMADO", "FALLIDO", "EXPIRADO", "DISPUTADO"],
  CONFIRMADO: ["REEMBOLSADO", "DISPUTADO"],
  FALLIDO: [],
  EXPIRADO: [],
  REEMBOLSADO: ["DISPUTADO"],
  DISPUTADO: ["CONFIRMADO", "REEMBOLSADO", "FALLIDO"],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function generateOrderCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) suffix += chars[b % chars.length];
  return `ORD-${suffix}`;
}

export function getAffiliateWindowDays(): number {
  const n = Number(process.env.AFFILIATE_ATTRIBUTION_DAYS ?? 7);
  return Number.isInteger(n) && n > 0 ? n : 7;
}

export type AffiliateResolution = {
  affiliateId: string | null;
  affiliateCode: string | null;
  clickedAt: Date | null;
  selfReferralBlocked: boolean;
};

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

/**
 * Atribución de afiliado (plan §2.4): ventana de 7 días, último clic.
 * Precedencia: código explícito (body o cookie pr_ref) > último clic
 * registrado dentro de la ventana. Auto-referido bloqueado: mismo
 * usuario, email o teléfono que el afiliado → sin comisión.
 */
export async function resolveAffiliate(input: {
  affiliateCode?: string | null;
  raffleId?: string | null;
  buyerEmail: string;
  buyerPhone?: string | null;
  userId?: string | null;
}): Promise<AffiliateResolution> {
  const none: AffiliateResolution = {
    affiliateId: null,
    affiliateCode: null,
    clickedAt: null,
    selfReferralBlocked: false,
  };
  const cutoff = new Date(Date.now() - getAffiliateWindowDays() * 24 * 60 * 60 * 1000);
  const buyerEmail = input.buyerEmail.trim().toLowerCase();
  const buyerPhone = normalizePhone(input.buyerPhone);

  const checkSelf = (affiliate: { id: string; email: string; phone: string | null }) => {
    if (input.userId && input.userId === affiliate.id) return true;
    if (affiliate.email.trim().toLowerCase() === buyerEmail) return true;
    const affPhone = normalizePhone(affiliate.phone);
    if (buyerPhone && affPhone && buyerPhone === affPhone) return true;
    return false;
  };

  // Último clic de un afiliado dentro de la ventana (específico de la
  // rifa primero, luego cualquier rifa).
  const latestClickFor = async (affiliateId: string) => {
    const byRaffle =
      input.raffleId != null
        ? await db.click.findFirst({
            where: { affiliateId, raffleId: input.raffleId, clickedAt: { gte: cutoff } },
            orderBy: { clickedAt: "desc" },
          })
        : null;
    if (byRaffle) return byRaffle;
    return db.click.findFirst({
      where: { affiliateId, clickedAt: { gte: cutoff } },
      orderBy: { clickedAt: "desc" },
    });
  };

  if (input.affiliateCode) {
    const code = input.affiliateCode.trim().toUpperCase();
    const affiliate = await db.user.findFirst({
      where: { referralCode: code, role: "AFILIADO" },
    });
    if (!affiliate) return none; // código inválido: no bloquea la compra
    if (checkSelf(affiliate)) return { ...none, selfReferralBlocked: true };
    const click = await latestClickFor(affiliate.id);
    const anyClick = await db.click.findFirst({
      where: { affiliateId: affiliate.id },
      orderBy: { clickedAt: "desc" },
    });
    // Si el afiliado tiene clics pero el último está fuera de la ventana,
    // la atribución expiró. Si nunca se registró clic, el código en mano
    // implica llegada por el enlace: se atribuye sin fecha de clic.
    if (anyClick && !click) return none;
    return { affiliateId: affiliate.id, affiliateCode: code, clickedAt: click?.clickedAt ?? null, selfReferralBlocked: false };
  }

  // Sin código: último clic dentro de la ventana (cualquier afiliado).
  const click =
    (input.raffleId != null
      ? await db.click.findFirst({
          where: { raffleId: input.raffleId, clickedAt: { gte: cutoff } },
          orderBy: { clickedAt: "desc" },
          include: { affiliate: true },
        })
      : null) ??
    (await db.click.findFirst({
      where: { clickedAt: { gte: cutoff } },
      orderBy: { clickedAt: "desc" },
      include: { affiliate: true },
    }));
  if (!click) return none;
  if (checkSelf(click.affiliate)) return { ...none, selfReferralBlocked: true };
  return {
    affiliateId: click.affiliateId,
    affiliateCode: click.affiliate.referralCode ?? click.code ?? null,
    clickedAt: click.clickedAt,
    selfReferralBlocked: false,
  };
}

export type OrderView = {
  id: string;
  code: string;
  raffleId: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string | null;
  totalAmount: number;
  currency: string;
  status: string;
  paymentMethodCode: string;
  paymentStatus: string | null;
  affiliateCode: string | null;
  createdAt: Date;
  tickets: Array<{ id: string; number: number; code: string; status: string }>;
};

export function presentOrder(order: {
  id: string;
  code: string;
  raffleId: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string | null;
  totalAmount: number;
  currency: string;
  status: string;
  paymentMethodCode: string;
  affiliateCode: string | null;
  createdAt: Date;
  tickets?: Array<{ id: string; number: number; code: string; status: string }>;
  payments?: Array<{ status: string }>;
}): OrderView {
  return {
    id: order.id,
    code: order.code,
    raffleId: order.raffleId,
    buyerName: order.buyerName,
    buyerEmail: order.buyerEmail,
    buyerPhone: order.buyerPhone,
    totalAmount: order.totalAmount,
    currency: order.currency,
    status: order.status,
    paymentMethodCode: order.paymentMethodCode,
    paymentStatus: order.payments?.[0]?.status ?? null,
    affiliateCode: order.affiliateCode,
    createdAt: order.createdAt,
    tickets: (order.tickets ?? []).map((t) => ({
      id: t.id,
      number: t.number,
      code: t.code,
      status: t.status,
    })),
  };
}

export async function getOrderByCode(code: string) {
  const order = await db.order.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: {
      tickets: { orderBy: { number: "asc" } },
      payments: { orderBy: { createdAt: "desc" }, take: 1 },
      raffle: { select: { id: true, title: true, ticketPrice: true, currency: true } },
    },
  });
  if (!order) throw notFound("Pedido no existe");
  return order;
}

export async function listOrdersForBuyer(input: {
  userId?: string | null;
  buyerEmail: string;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  const where = {
    OR: [
      ...(input.userId ? [{ userId: input.userId }] : []),
      { buyerEmail: input.buyerEmail.trim().toLowerCase() },
    ],
  };
  const [orders, total] = await Promise.all([
    db.order.findMany({
      where,
      include: { tickets: { orderBy: { number: "asc" } }, payments: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.order.count({ where }),
  ]);
  return { data: orders.map(presentOrder), page, total };
}

export type CreateOrderResult = {
  order: OrderView;
  tickets: Array<{ id: string; number: number; code: string; status: string }>;
  paymentInstructions: {
    method: string;
    label: string;
    details: string;
    reference: string;
    amount: number;
    currency: string;
  } | null;
  created: boolean;
  selfReferralBlocked: boolean;
};

/**
 * Crea un pedido (PENDIENTE + Payment PENDIENTE + tickets RESERVADO).
 * Idempotente por Idempotency-Key: si ya existe un pedido con esa clave,
 * lo devuelve sin crear nada nuevo (created: false).
 */
export async function createOrder(input: {
  raffleId: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string | null;
  userId?: string | null;
  paymentMethodCode: PaymentMethodCode;
  reservationId?: string | null;
  numbers?: number[];
  quantity?: number;
  affiliateCode?: string | null;
  useLatestClick?: boolean;
  idempotencyKey: string;
  acceptTerms?: boolean;
}): Promise<CreateOrderResult> {
  const buyerEmail = input.buyerEmail.trim().toLowerCase();
  if (input.acceptTerms === false) {
    throw new ApiError(400, "Debes aceptar las bases de la rifa para comprar", "TERMS_NOT_ACCEPTED");
  }
  if (!input.idempotencyKey || !input.idempotencyKey.trim()) {
    throw new ApiError(400, "Falta la clave de idempotencia (header Idempotency-Key)", "IDEMPOTENCY_KEY_REQUIRED");
  }
  const key = input.idempotencyKey.trim();

  // Replay: mismo pedido, sin efectos duplicados (P20).
  const existing = await db.order.findUnique({
    where: { idempotencyKey: key },
    include: { tickets: { orderBy: { number: "asc" } }, payments: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (existing) {
    return {
      order: presentOrder(existing),
      tickets: existing.tickets.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
      paymentInstructions: await paymentInstructionsFor(existing),
      created: false,
      selfReferralBlocked: false,
    };
  }

  const raffle = await db.raffle.findUnique({ where: { id: input.raffleId } });
  if (!raffle) throw notFound("Rifa no existe");
  if (raffle.status !== "ACTIVA") {
    throw new ApiError(409, `La rifa no está activa (estado: ${raffle.status})`, "RAFFLE_NOT_ACTIVE");
  }

  // Solo MANUAL_TRANSFER es operativo en Fase 1 (regla 6 del plan).
  if (input.paymentMethodCode !== "MANUAL_TRANSFER") {
    throw notConfigured(
      `El método ${input.paymentMethodCode} no está operativo todavía (falta verificación real con el proveedor)`,
    );
  }
  const provider = await db.paymentProvider.findUnique({ where: { code: "MANUAL_TRANSFER" } });
  if (provider && provider.status !== "OPERATIVO") {
    throw notConfigured("La transferencia manual no está operativa");
  }
  if (!provider) {
    throw notConfigured("La transferencia manual no está configurada");
  }
  const method = await db.paymentMethod.findUnique({ where: { code: "MANUAL_TRANSFER" } });

  // Reserva (si viene): debe estar ACTIVA, vigente, de esta rifa y del
  // mismo comprador. Sus números son los del pedido.
  let reservationNumbers: number[] | null = null;
  if (input.reservationId) {
    const reservation = await getActiveReservation(input.reservationId);
    if (reservation.raffleId !== raffle.id) {
      throw conflict("La reserva pertenece a otra rifa", "RESERVATION_MISMATCH");
    }
    if (reservation.buyerEmail.toLowerCase() !== buyerEmail) {
      throw conflict("La reserva pertenece a otro correo", "RESERVATION_MISMATCH");
    }
    reservationNumbers = (reservation.numbers as number[]).slice().sort((a, b) => a - b);
    if (reservationNumbers.length === 0) {
      throw conflict("La reserva no tiene boletos", "RESERVATION_EMPTY");
    }
  } else if (!input.numbers?.length && !input.quantity) {
    throw new ApiError(400, "Indica reservationId, numbers o quantity", "VALIDATION_ERROR");
  }

  const attribution = input.affiliateCode
    ? await resolveAffiliate({
        affiliateCode: input.affiliateCode,
        raffleId: raffle.id,
        buyerEmail,
        buyerPhone: input.buyerPhone ?? null,
        userId: input.userId ?? null,
      })
    : input.useLatestClick
      ? await resolveAffiliate({
          affiliateCode: null,
          raffleId: raffle.id,
          buyerEmail,
          buyerPhone: input.buyerPhone ?? null,
          userId: input.userId ?? null,
        })
      : { affiliateId: null, affiliateCode: null, clickedAt: null, selfReferralBlocked: false };

  const count = reservationNumbers?.length ?? input.numbers?.length ?? input.quantity ?? 0;

  // Bloqueo de compras por fraude (S9-int, plan §2.14): un comprador o
  // un afiliado BLOQUEADO no puede comprar (403 con motivo). Se comprueba
  // DESPUÉS de resolver la atribución (para incluir al afiliado) y ANTES
  // de crear nada: ni pedido, ni reserva consumida, ni boletos. La
  // respuesta idempotente (replay) ya se devolvió arriba, así que un
  // reintento con la misma clave de un pedido ya creado no se bloquea.
  const fraudBlock = await isBlockedFromPurchasing(db, {
    buyerEmail,
    userId: input.userId ?? null,
    affiliateId: attribution.affiliateId,
  });
  if (fraudBlock.blocked) {
    throw new ApiError(403, fraudBlock.reason ?? "Compra bloqueada por fraude", "PURCHASE_BLOCKED_FRAUD");
  }

  if (raffle.maxTicketsPerPurchase !== null && count > raffle.maxTicketsPerPurchase) {
    throw conflict(`Máximo ${raffle.maxTicketsPerPurchase} boletos por compra en esta rifa`, "MAX_PER_PURCHASE");
  }
  const totalAmount = raffle.ticketPrice * count;

  let createdOrder;
  try {
    createdOrder = await db.$transaction(async (tx: Tx) => {
      const fresh = await tx.raffle.findUnique({ where: { id: raffle.id } });
      if (!fresh || fresh.status !== "ACTIVA") {
        throw new ApiError(409, "La rifa ya no está activa", "RAFFLE_NOT_ACTIVE");
      }
      const order = await tx.order.create({
        data: {
          code: generateOrderCode(),
          raffleId: raffle.id,
          userId: input.userId ?? null,
          buyerName: input.buyerName.trim(),
          buyerEmail,
          buyerPhone: input.buyerPhone?.trim() || null,
          paymentMethodCode: input.paymentMethodCode,
          affiliateId: attribution.affiliateId,
          affiliateCode: attribution.affiliateCode,
          totalAmount,
          currency: raffle.currency,
          status: "PENDIENTE",
          idempotencyKey: key,
        },
      });
      await tx.payment.create({
        data: {
          orderId: order.id,
          providerId: provider.id,
          providerCode: "MANUAL_TRANSFER",
          amount: totalAmount,
          currency: raffle.currency,
          methodCode: input.paymentMethodCode,
          status: "PENDIENTE",
        },
      });

      let tickets;
      if (reservationNumbers) {
        // Consume la reserva: CONFIRMADA + boletos vinculados al pedido.
        await tx.reservation.update({
          where: { id: input.reservationId as string, status: "ACTIVA" },
          data: { status: "CONFIRMADA" },
        });
        const updated = await tx.ticket.updateMany({
          where: {
            reservationId: input.reservationId as string,
            status: "RESERVADO",
            raffleId: raffle.id,
          },
          data: {
            orderId: order.id,
            buyerName: input.buyerName.trim(),
            buyerEmail,
            buyerPhone: input.buyerPhone?.trim() || null,
            affiliateId: attribution.affiliateId,
          },
        });
        if (updated.count !== reservationNumbers.length) {
          throw conflict(
            "La reserva cambió mientras se procesaba la compra; vuelve a reservar",
            "RESERVATION_CHANGED",
          );
        }
        tickets = await tx.ticket.findMany({
          where: { orderId: order.id },
          orderBy: { number: "asc" },
        });
      } else {
        // Compra directa sin reserva previa: reserva los números dentro
        // de esta misma transacción (sin doble reserva).
        const owned = await tx.ticket.count({
          where: { raffleId: raffle.id, buyerEmail, status: { in: ["RESERVADO", "VENDIDO"] } },
        });
        if (raffle.maxTicketsPerCustomer !== null && owned + count > raffle.maxTicketsPerCustomer) {
          throw conflict(
            `Máximo ${raffle.maxTicketsPerCustomer} boletos por cliente en esta rifa (ya tienes ${owned})`,
            "MAX_PER_CUSTOMER",
          );
        }
        await reserveNumbersTx(tx, fresh, {
          numbers: input.numbers,
          quantity: input.quantity,
          buyerEmail,
          orderId: order.id,
          affiliateId: attribution.affiliateId,
        });
        // reserveNumbersTx no guarda buyerName/phone: se completan aquí.
        await tx.ticket.updateMany({
          where: { orderId: order.id },
          data: {
            buyerName: input.buyerName.trim(),
            buyerPhone: input.buyerPhone?.trim() || null,
          },
        });
        tickets = await tx.ticket.findMany({
          where: { orderId: order.id },
          orderBy: { number: "asc" },
        });
      }

      // Aceptación de bases: versión vigente en el momento de la compra.
      if (raffle.termsVersionId) {
        await tx.termsAcceptance.upsert({
          where: {
            raffleId_termsId_buyerEmail: {
              raffleId: raffle.id,
              termsId: raffle.termsVersionId,
              buyerEmail,
            },
          },
          update: {},
          create: {
            raffleId: raffle.id,
            termsId: raffle.termsVersionId,
            userId: input.userId ?? null,
            buyerEmail,
          },
        });
      }
      return { order, tickets };
    }, { maxWait: 20000, timeout: 30000 });
  } catch (err) {
    // Carrera con la misma clave: otro intento creó el pedido primero.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      const replay = await db.order.findUnique({
        where: { idempotencyKey: key },
        include: { tickets: { orderBy: { number: "asc" } }, payments: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (replay) {
        return {
          order: presentOrder(replay),
          tickets: replay.tickets.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
          paymentInstructions: await paymentInstructionsFor(replay),
          created: false,
          selfReferralBlocked: false,
        };
      }
    }
    throw err;
  }

  // Registro de la clave de idempotencia (para withIdempotency / auditoría).
  await db.idempotencyKey
    .upsert({
      where: { key_scope: { key, scope: "order" } },
      update: { response: { orderId: createdOrder.order.id, code: createdOrder.order.code } },
      create: {
        key,
        scope: "order",
        response: { orderId: createdOrder.order.id, code: createdOrder.order.code },
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })
    .catch(() => undefined);

  await logAudit({
    actorId: input.userId ?? null,
    action: "orders.create",
    entity: "Order",
    entityId: createdOrder.order.id,
    after: {
      code: createdOrder.order.code,
      raffleId: raffle.id,
      totalAmount,
      tickets: createdOrder.tickets.map((t) => t.number),
      affiliateId: attribution.affiliateId,
      affiliateCode: attribution.affiliateCode,
      selfReferralBlocked: attribution.selfReferralBlocked,
      paymentMethodCode: input.paymentMethodCode,
    },
  });

  const full = await db.order.findUnique({
    where: { id: createdOrder.order.id },
    include: { tickets: { orderBy: { number: "asc" } }, payments: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const view = presentOrder(full ?? { ...createdOrder.order, tickets: createdOrder.tickets, payments: [{ status: "PENDIENTE" }] });
  return {
    order: view,
    tickets: createdOrder.tickets.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
    paymentInstructions: {
      method: "MANUAL_TRANSFER",
      label: method?.label ?? "Transferencia bancaria",
      details: method?.details ?? "",
      reference: createdOrder.order.code,
      amount: totalAmount,
      currency: raffle.currency,
    },
    created: true,
    selfReferralBlocked: attribution.selfReferralBlocked,
  };
}

async function paymentInstructionsFor(order: {
  code: string;
  totalAmount: number;
  currency: string;
  paymentMethodCode: string;
}) {
  if (order.paymentMethodCode !== "MANUAL_TRANSFER") return null;
  const method = await db.paymentMethod.findUnique({ where: { code: "MANUAL_TRANSFER" } });
  return {
    method: "MANUAL_TRANSFER",
    label: method?.label ?? "Transferencia bancaria",
    details: method?.details ?? "",
    reference: order.code,
    amount: order.totalAmount,
    currency: order.currency,
  };
}

/**
 * Cancela un pedido PENDIENTE (admin): libera sus boletos
 * (RESERVADO → DISPONIBLE) y marca el pedido EXPIRADO. Un pedido
 * CONFIRMADO no se cancela por aquí: necesita reembolso (S6).
 */
export async function cancelOrder(
  orderId: string,
  input: { actorId: string; reason?: string },
) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { tickets: true },
  });
  if (!order) throw notFound("Pedido no existe");
  if (order.status !== "PENDIENTE") {
    throw conflict(
      `Solo se puede cancelar un pedido PENDIENTE (actual: ${order.status})${order.status === "CONFIRMADO" ? ": usa el flujo de reembolso" : ""}`,
      "ORDER_NOT_CANCELLABLE",
    );
  }
  const reservationIds = [...new Set(order.tickets.map((t) => t.reservationId).filter((x): x is string => Boolean(x)))];
  const updated = await db.$transaction(async (tx: Tx) => {
    const o = await tx.order.update({
      where: { id: orderId, status: "PENDIENTE" },
      data: { status: "EXPIRADO" },
    });
    await tx.ticket.updateMany({
      where: { orderId, status: "RESERVADO" },
      data: { status: "DISPONIBLE", orderId: null, reservationId: null },
    });
    await tx.payment.updateMany({
      where: { orderId, status: "PENDIENTE" },
      data: { status: "FALLIDO" },
    });
    for (const rid of reservationIds) {
      await tx.reservation.updateMany({
        where: { id: rid, status: "CONFIRMADA" },
        data: { status: "CANCELADA" },
      });
    }
    return o;
  });
  await logAudit({
    actorId: input.actorId,
    action: "orders.cancel",
    entity: "Order",
    entityId: orderId,
    before: { status: "PENDIENTE", tickets: order.tickets.map((t) => t.number) },
    after: { status: "EXPIRADO", reason: input.reason ?? null, ticketsReleased: order.tickets.length },
  });
  return presentOrder({ ...updated, tickets: [], payments: [] });
}

export type RecoveryResult = {
  order: OrderView;
  tickets: Array<{ id: string; number: number; code: string; status: string }>;
  recovered: boolean;
  message: string;
};

/**
 * Recuperación P19 (plan §2.12): pago CONFIRMADO sin boletos emitidos.
 * Emite los boletos (VENDIDO) y confirma el pedido. Idempotente: si el
 * pedido ya tiene boletos, no emite duplicados y devuelve los existentes.
 * Si un número ya está ocupado por otro comprador, no se inventa otro:
 * lanza 409 y abre un caso de conciliación ABIERTO para revisión humana.
 */
export async function recoverConfirmedPaymentWithoutTickets(
  orderId: string,
  numbers: number[],
  input: { actorId?: string | null; reason?: string },
): Promise<RecoveryResult> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      tickets: { orderBy: { number: "asc" } },
      payments: { orderBy: { createdAt: "desc" } },
      raffle: true,
    },
  });
  if (!order) throw notFound("Pedido no existe");
  const paid = order.payments.find((p) => p.status === "APROBADO");
  if (!paid) {
    throw conflict("No hay un pago confirmado que recuperar en este pedido", "RECOVERY_NO_CONFIRMED_PAYMENT");
  }
  if (order.tickets.length > 0) {
    return {
      order: presentOrder({ ...order, payments: order.payments.slice(0, 1) }),
      tickets: order.tickets.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
      recovered: false,
      message: "El pedido ya tenía boletos emitidos; no se duplicó nada",
    };
  }
  const uniqueNumbers = [...new Set(numbers)].sort((a, b) => a - b);
  if (uniqueNumbers.length === 0) {
    throw new ApiError(400, "Indica los números a emitir en la recuperación", "VALIDATION_ERROR");
  }
  for (const n of uniqueNumbers) {
    if (!Number.isInteger(n) || n < 1 || n > order.raffle.totalTickets) {
      throw new ApiError(400, `Número inválido: ${n}`, "INVALID_NUMBER");
    }
  }

  try {
    const issued = await db.$transaction(async (tx: Tx) => {
      const fresh = await tx.order.findUnique({
        where: { id: orderId },
        include: { tickets: true },
      });
      if (!fresh) throw notFound("Pedido no existe");
      if (fresh.tickets.length > 0) return fresh.tickets; // carrera: ya recuperado
      const existing = await tx.ticket.findMany({
        where: { raffleId: order.raffleId, number: { in: uniqueNumbers } },
        select: { id: true, number: true, status: true },
      });
      const byNumber = new Map(existing.map((t) => [t.number, t]));
      for (const n of uniqueNumbers) {
        const row = byNumber.get(n);
        if (row && row.status !== "DISPONIBLE" && row.status !== "ANULADO") {
          throw conflict(
            `El boleto ${n} ya está ocupado (${row.status}); la recuperación necesita revisión humana`,
            "RECOVERY_NUMBER_TAKEN",
          );
        }
      }
      const out = [];
      for (const n of uniqueNumbers) {
        const row = byNumber.get(n);
        if (!row) {
          out.push(
            await tx.ticket.create({
              data: {
                raffleId: order.raffleId,
                number: n,
                code: `PR-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${String(n).padStart(4, "0")}`,
                status: "VENDIDO",
                orderId: order.id,
                buyerName: order.buyerName,
                buyerEmail: order.buyerEmail,
                buyerPhone: order.buyerPhone,
                affiliateId: order.affiliateId,
              },
            }),
          );
        } else {
          const updated = await tx.ticket.updateMany({
            where: { id: row.id, status: { in: ["DISPONIBLE", "ANULADO"] } },
            data: {
              status: "VENDIDO",
              orderId: order.id,
              buyerName: order.buyerName,
              buyerEmail: order.buyerEmail,
              buyerPhone: order.buyerPhone,
              affiliateId: order.affiliateId,
            },
          });
          if (updated.count !== 1) {
            throw conflict(`El boleto ${n} ya está ocupado; la recuperación necesita revisión humana`, "RECOVERY_NUMBER_TAKEN");
          }
          const reloaded = await tx.ticket.findUnique({ where: { id: row.id } });
          if (reloaded) out.push(reloaded);
        }
      }
      await tx.order.update({ where: { id: orderId }, data: { status: "CONFIRMADO" } });
      return out;
    });
    await logAudit({
      actorId: input.actorId ?? null,
      action: "orders.recover-confirmed-payment",
      entity: "Order",
      entityId: orderId,
      before: { status: order.status, tickets: 0, paymentStatus: "APROBADO" },
      after: { status: "CONFIRMADO", tickets: uniqueNumbers, reason: input.reason ?? "pago confirmado sin boletos" },
    });
    // Caso visible de recuperación/conciliación, ya resuelto (plan §2.12:
    // la recuperación nunca altera registros en silencio).
    await db.reconciliationCase.create({
      data: {
        provider: paid.providerCode ?? "MANUAL_TRANSFER",
        status: "RESUELTO",
        detail: {
          kind: "pago-confirmado-sin-boletos",
          orderId,
          orderCode: order.code,
          numbers: uniqueNumbers,
          reason: input.reason ?? "recuperación P19",
        },
        amount: paid.amount,
        currency: paid.currency,
        resolvedAt: new Date(),
        resolvedById: input.actorId ?? null,
      },
    });
    const full = await getOrderByCode(order.code);
    return {
      order: presentOrder(full),
      tickets: issued.map((t) => ({ id: t.id, number: t.number, code: t.code, status: t.status })),
      recovered: true,
      message: "Boletos emitidos y pedido confirmado",
    };
  } catch (err) {
    if (err instanceof ApiError && err.code === "RECOVERY_NUMBER_TAKEN") {
      await db.reconciliationCase.create({
        data: {
          provider: paid.providerCode ?? "MANUAL_TRANSFER",
          status: "ABIERTO",
          detail: {
            kind: "pago-confirmado-sin-boletos-numero-ocupado",
            orderId,
            orderCode: order.code,
            numbers: uniqueNumbers,
            error: err.message,
          },
          amount: paid.amount,
          currency: paid.currency,
        },
      });
    }
    throw err;
  }
}
