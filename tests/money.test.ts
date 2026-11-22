// Dinero en enteros + formato de comisión estandarizado (POR CIENTO).
// Verificación del coordinador: venta RD$1,000 con referido → RD$100 (10%).
import { describe, expect, it } from "vitest";
import { commissionAmount, commissionForSale, formatMoney, parseCommissionRatePercent } from "../src/lib/money";

describe("comisión de afiliados (por ciento)", () => {
  it("venta de RD$1,000 genera exactamente RD$100 de comisión (10%)", () => {
    expect(commissionAmount(1000, 10)).toBe(100);
  });

  it("commissionForSale con la tasa vigente (10%) → 100 sobre 1,000", async () => {
    process.env.COMMISSION_RATE = "10";
    expect(await commissionForSale(1000)).toBe(100);
    expect(await commissionForSale(250)).toBe(25);
    expect(await commissionForSale(0)).toBe(0);
  });

  it("parseCommissionRatePercent: '10' = 10% y '0.10' legada = 10%", () => {
    expect(parseCommissionRatePercent("10")).toBe(10);
    expect(parseCommissionRatePercent(10)).toBe(10);
    expect(parseCommissionRatePercent("0.10")).toBe(10); // fracción legada SPEC v1
    expect(parseCommissionRatePercent("0.1")).toBe(10);
    expect(parseCommissionRatePercent(undefined)).toBe(10); // defecto
    expect(() => parseCommissionRatePercent("150")).toThrow();
    expect(() => parseCommissionRatePercent("-5")).toThrow();
  });

  it("la comisión nunca usa el valor tal cual como fracción (no 10x)", () => {
    // Si alguien pasara 10 como fracción (10 = 1000%), el cálculo daría 10,000.
    // Con el formato por ciento estandarizado, 10% de 1,000 es 100, no 10,000.
    expect(commissionAmount(1000, parseCommissionRatePercent("10"))).toBe(100);
    expect(commissionAmount(1000, parseCommissionRatePercent("0.10"))).toBe(100);
  });

  it("redondeo hacia abajo en enteros (sin floats)", () => {
    expect(commissionAmount(999, 10)).toBe(99);
    expect(commissionAmount(5, 10)).toBe(0);
  });

  it("formatMoney solo presenta, no calcula", () => {
    expect(formatMoney(1000, "DOP")).toContain("1,000");
  });
});
