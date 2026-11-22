// Ledger inmutable (plan §2.3): append-only. Solo se INSERTA; no existe
// ninguna función de update/delete para LedgerEntry en este módulo.
// Los errores se corrigen con asientos compensatorios (type AJUSTE) que
// referencian al asiento original. Los saldos se DERIVAN del ledger.
import { Prisma } from "../generated/prisma/client";
import type { LedgerEntryType } from "../generated/prisma/client";
import { db, type Tx } from "./db";

export type LedgerInput = {
  type: LedgerEntryType;
  amount: number; // entero; positivo = entrada, negativo = salida/ajuste
  currency: string;
  refType: string;
  refId: string;
  metadata?: Record<string, unknown>;
};

type Client = typeof db | Tx;

/** Único punto de escritura del ledger. Siempre dentro de transacción. */
export async function appendLedgerEntry(client: Client, input: LedgerInput) {
  if (!Number.isInteger(input.amount)) {
    throw new Error("El monto del ledger debe ser entero");
  }
  return client.ledgerEntry.create({
    data: {
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      refType: input.refType,
      refId: input.refId,
      metadata: input.metadata
        ? (input.metadata as Prisma.InputJsonValue)
        : undefined,
    },
  });
}

/** Saldo derivado: suma de asientos para una referencia (o tipo). */
export async function ledgerBalance(
  client: Client,
  where: { refType?: string; refId?: string; type?: LedgerEntryType; currency?: string },
): Promise<number> {
  const result = await client.ledgerEntry.aggregate({
    where: {
      refType: where.refType,
      refId: where.refId,
      type: where.type,
      currency: where.currency,
    },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

/** Historial de asientos de una referencia, en orden cronológico. */
export async function ledgerEntriesFor(client: Client, refType: string, refId: string) {
  return client.ledgerEntry.findMany({
    where: { refType, refId },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------- reportes (S6, plan §2.3)
// Los saldos se DERIVAN del ledger + del estado de las comisiones; nunca
// hay columnas editables de saldo. Todas las sumas son enteros con signo:
// VENTA positivo; REEMBOLSO/CONTRACARGO/COMISION/RETIRO negativos (salidas
// o pasivos); AJUSTE con el signo que corresponda (reversión positiva,
// compensación negativa). El filtro de fechas es inclusivo por createdAt.

export type LedgerBalances = {
  currency: string;
  /** Cobrado confirmado: suma de VENTA. */
  ventas: number;
  /** Devoluciones a clientes: suma de REEMBOLSO (negativo). */
  reembolsos: number;
  /** Contracargos: suma de CONTRACARGO (negativo). */
  contracargos: number;
  /** Costos registrados (premio, proveedor, operación): suma de COSTO. */
  costos: number;
  /** Pasivo por comisiones: COMISION (negativo) + AJUSTE sobre Commission. */
  comisionesNeto: number;
  /** Retiros pagados a afiliados: suma de RETIRO (negativo). */
  retiros: number;
  /** Reservas retenidas: suma de RESERVA. */
  reservas: number;
  /** Ajustes manuales/compensatorios no ligados a comisión: suma de AJUSTE. */
  ajustesOtros: number;
  /** Neto del período/moneda: suma de todos los asientos. */
  neto: number;
  /** Desglose de comisiones por estado (fuente: tabla Commission). */
  comisionesPorEstado: { PENDING: number; RETAINED: number; AVAILABLE: number; PAID: number; ADJUSTED: number };
  /** Comprometido en comisiones (PENDING + RETAINED, aún no disponible). */
  comisionesComprometidas: number;
  /** Disponible para retirar (AVAILABLE neto de compensaciones negativas). */
  comisionesDisponibles: number;
  /** Pagado en comisiones (PAID). */
  comisionesPagadas: number;
  /** En disputa: suma de totalAmount de pedidos DISPUTADO (no es asiento). */
  enDisputaPedidos: number;
  /** Nº de asientos en el rango. */
  movimientos: number;
};

export type LedgerBalancesInput = {
  currency?: string;
  from?: Date;
  to?: Date;
};

/**
 * Saldos por cuenta para una moneda (o todas, agregadas por moneda fuera
 * de aquí: si no se pasa currency, se agregan TODAS las monedas juntas —
 * solo usarlo con una moneda; el reporte por moneda se hace llamando una
 * vez por moneda, ver `ledgerCurrencies`).
 */
export async function getLedgerBalances(
  client: Client,
  input: LedgerBalancesInput = {},
): Promise<LedgerBalances> {
  const dateFilter =
    input.from || input.to
      ? { gte: input.from, lte: input.to }
      : undefined;
  const where = {
    ...(input.currency ? { currency: input.currency } : {}),
    ...(dateFilter ? { createdAt: dateFilter } : {}),
  };
  const entries = await client.ledgerEntry.findMany({
    where,
    select: { type: true, amount: true, refType: true, refId: true, currency: true },
  });
  const sum = (type: LedgerEntryType) =>
    entries.filter((e) => e.type === type).reduce((acc, e) => acc + e.amount, 0);
  const sumAjusteCommission = entries
    .filter((e) => e.type === "AJUSTE" && e.refType === "Commission")
    .reduce((acc, e) => acc + e.amount, 0);
  const sumAjusteOtros = entries
    .filter((e) => e.type === "AJUSTE" && e.refType !== "Commission")
    .reduce((acc, e) => acc + e.amount, 0);

  // Comisiones por estado (tabla Commission, no ledger: el estado manda).
  const commissions = await client.commission.findMany({
    where: input.currency ? { currency: input.currency } : {},
    select: { status: true, amount: true },
  });
  const porEstado = { PENDING: 0, RETAINED: 0, AVAILABLE: 0, PAID: 0, ADJUSTED: 0 };
  for (const c of commissions) porEstado[c.status] += c.amount;

  // Compensaciones negativas pendientes de absorber (AJUSTE negativos
  // kind compensacion-comision-pagada): reducen el disponible. Se leen
  // del ledger de las comisiones del afiliado — aquí, global por moneda,
  // se suman los AJUSTE negativos sobre Commission que no son reversión
  // de una comisión PENDING/RETAINED (esas son positivas).
  const compensaciones = entries
    .filter((e) => e.type === "AJUSTE" && e.refType === "Commission" && e.amount < 0)
    .reduce((acc, e) => acc + e.amount, 0);

  const disputed = await client.order.findMany({
    where: {
      status: "DISPUTADO",
      ...(input.currency ? { currency: input.currency } : {}),
    },
    select: { totalAmount: true },
  });

  const ventas = sum("VENTA");
  const reembolsos = sum("REEMBOLSO");
  const contracargos = sum("CONTRACARGO");
  const costos = sum("COSTO");
  const comisionesNeto = sum("COMISION") + sumAjusteCommission;
  const retiros = sum("RETIRO");
  const reservas = sum("RESERVA");
  const neto = entries.reduce((acc, e) => acc + e.amount, 0);

  return {
    currency: input.currency ?? "*",
    ventas,
    reembolsos,
    contracargos,
    costos,
    comisionesNeto,
    retiros,
    reservas,
    ajustesOtros: sumAjusteOtros,
    neto,
    comisionesPorEstado: porEstado,
    comisionesComprometidas: porEstado.PENDING + porEstado.RETAINED,
    comisionesDisponibles: porEstado.AVAILABLE + compensaciones,
    comisionesPagadas: porEstado.PAID,
    enDisputaPedidos: disputed.reduce((acc, o) => acc + o.totalAmount, 0),
    movimientos: entries.length,
  };
}

/** Monedas con movimientos en el ledger (para reportes por moneda). */
export async function ledgerCurrencies(client: Client): Promise<string[]> {
  const rows = await client.ledgerEntry.findMany({
    select: { currency: true },
    distinct: ["currency"],
  });
  return rows.map((r) => r.currency).sort();
}

export type LedgerMovementsInput = {
  currency?: string;
  type?: LedgerEntryType;
  refType?: string;
  refId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
};

/** Movimientos por rango de fechas, con filtros y paginación (más reciente primero). */
export async function getLedgerMovements(client: Client, input: LedgerMovementsInput = {}) {
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  const where: Record<string, unknown> = {};
  if (input.currency) where.currency = input.currency;
  if (input.type) where.type = input.type;
  if (input.refType) where.refType = input.refType;
  if (input.refId) where.refId = input.refId;
  if (input.from || input.to) {
    where.createdAt = { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) };
  }
  const [entries, total] = await Promise.all([
    client.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    client.ledgerEntry.count({ where }),
  ]);
  return { data: entries, page, total };
}

/** Exportación de movimientos a CSV (cabecera + una fila por asiento). */
export function ledgerMovementsToCsv(
  entries: Array<{ id: string; type: string; amount: number; currency: string; refType: string; refId: string; createdAt: Date; metadata?: unknown }>,
): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["id,type,amount,currency,refType,refId,createdAt,metadata"];
  for (const e of entries) {
    lines.push(
      [
        esc(e.id),
        esc(e.type),
        esc(e.amount),
        esc(e.currency),
        esc(e.refType),
        esc(e.refId),
        esc(e.createdAt.toISOString()),
        esc(e.metadata === undefined ? "" : JSON.stringify(e.metadata)),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
