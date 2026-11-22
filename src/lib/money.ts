// Dinero en ENTEROS (unidades mayores de la moneda: 100 = RD$100).
// Nunca floats para dinero (regla de código v2.2).
import { db } from "./db";

// ---------------------------------------------------------------------------
// Comisión de afiliados — FORMATO ESTANDARIZADO: POR CIENTO.
// ---------------------------------------------------------------------------
// El valor canónico es POR CIENTO: "10" = 10% (así quedó en .env.example,
// creado en S0: COMMISSION_RATE="10").
// La SPEC v1 lo tenía como fracción ("0.10"). Para no pagar 10x la comisión
// por confundir formatos, el parser acepta AMBOS y normaliza a por ciento:
//   - 0 < valor <= 1  → se interpreta como fracción legada (0.10 → 10)
//   - 1 < valor <= 100 → por ciento tal cual (10 → 10)
//   - cualquier otro valor → error.
// El cálculo usa puntos básicos enteros (rateBps = porCiento * 100) para
// que la multiplicación sea entera: comisión = floor(total * bps / 10000).
// Ejemplo verificado en tests/money.test.ts: venta RD$1,000 → RD$100.

export function parseCommissionRatePercent(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return 10; // defecto del plan
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`COMMISSION_RATE inválido: ${String(raw)}`);
  }
  if (value > 0 && value <= 1) return value * 100; // fracción legada 0.10 → 10%
  if (value <= 100) return value; // por ciento
  throw new Error(`COMMISSION_RATE fuera de rango (0-100%): ${String(raw)}`);
}

/** Comisión en enteros. Ej: commissionAmount(1000, 10) === 100. */
export function commissionAmount(totalAmount: number, ratePercent: number): number {
  assertIntegerMoney(totalAmount, "totalAmount");
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw new Error(`Tasa de comisión inválida: ${ratePercent}`);
  }
  const rateBps = Math.round(ratePercent * 100); // 10% → 1000 bps
  return Math.floor((totalAmount * rateBps) / 10000);
}

/** Tasa vigente: Setting COMMISSION_RATE (por ciento) o env, defecto 10%. */
export async function getCommissionRatePercent(): Promise<number> {
  try {
    const setting = await db.setting.findUnique({ where: { key: "COMMISSION_RATE" } });
    if (setting) return parseCommissionRatePercent(setting.value);
  } catch {
    // Sin BD disponible (tests unitarios): cae al env.
  }
  return parseCommissionRatePercent(process.env.COMMISSION_RATE);
}

/** Comisión de una venta con la tasa vigente. */
export async function commissionForSale(totalAmount: number): Promise<number> {
  const rate = await getCommissionRatePercent();
  return commissionAmount(totalAmount, rate);
}

// ---------------------------------------------------------------------------
// Utilidades de dinero
// ---------------------------------------------------------------------------

export function assertIntegerMoney(value: unknown, field = "amount"): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} debe ser un entero no negativo (unidades mayores), recibido: ${String(value)}`);
  }
}

/** Formatea un entero como moneda (solo presentación, nunca para calcular). */
export function formatMoney(amount: number, currency = "DOP", locale = "es-DO"): string {
  assertIntegerMoney(amount);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}
