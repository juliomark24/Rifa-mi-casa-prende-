// Sorteo verificable: determinismo y verificación independiente (aclaración 1).
import { describe, expect, it } from "vitest";
import {
  computeDraw,
  createCommitment,
  drawWinnerIndex,
  generateSeed,
  hashEligibleSnapshot,
  serializeEligible,
  verifyDraw,
} from "../src/lib/draw";

describe("draw helpers", () => {
  it("misma seed + misma lista = mismo ganador (determinismo)", () => {
    const a = computeDraw([5, 1, 9, 3, 7], "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");
    const b = computeDraw([5, 1, 9, 3, 7], "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");
    expect(a).toEqual(b);
    expect(a.winnerNumber).toBeGreaterThanOrEqual(1);
  });

  it("el orden de entrada no cambia el resultado (serialización ordenada)", () => {
    const seed = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const a = computeDraw([1, 2, 3, 4, 5], seed);
    const b = computeDraw([5, 4, 3, 2, 1], seed);
    expect(a.winnerNumber).toBe(b.winnerNumber);
    expect(a.commitment).toBe(b.commitment);
    expect(serializeEligible([5, 3, 1])).toBe("[1,3,5]");
  });

  it("semillas distintas pueden dar ganadores distintos; la semilla es CSPRNG", () => {
    const s1 = generateSeed();
    const s2 = generateSeed();
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect(s1).not.toBe(s2);
    const a = computeDraw([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], s1);
    const b = computeDraw([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], s2);
    expect(a.seed).not.toBe(b.seed);
    expect(a.commitment).not.toBe(b.commitment);
  });

  it("verificación independiente reproduce el ganador", () => {
    const draw = computeDraw([10, 20, 30, 40, 50]);
    const v = verifyDraw({
      seed: draw.seed,
      eligibleSnapshot: draw.eligibleSnapshot,
      commitment: draw.commitment,
      winnerNumber: draw.winnerNumber,
    });
    expect(v.valid).toBe(true);
    expect(v.commitmentMatches).toBe(true);
    expect(v.winnerNumber).toBe(draw.winnerNumber);
  });

  it("verificación falla si la semilla fue alterada", () => {
    const draw = computeDraw([10, 20, 30, 40, 50]);
    const v = verifyDraw({
      seed: "00".repeat(32),
      eligibleSnapshot: draw.eligibleSnapshot,
      commitment: draw.commitment,
      winnerNumber: draw.winnerNumber,
    });
    expect(v.valid).toBe(false);
    expect(v.commitmentMatches).toBe(false);
  });

  it("verificación falla si la lista fue alterada tras el compromiso", () => {
    const draw = computeDraw([10, 20, 30, 40, 50]);
    const tamperedSnapshot = serializeEligible([10, 20, 30, 40, 51]);
    const v = verifyDraw({
      seed: draw.seed,
      eligibleSnapshot: tamperedSnapshot,
      commitment: draw.commitment,
      winnerNumber: draw.winnerNumber,
    });
    expect(v.valid).toBe(false);
  });

  it("commitment = SHA256(seed + ':' + hashElegibles); índice en rango", () => {
    const snapshot = serializeEligible([1, 2, 3]);
    const hash = hashEligibleSnapshot(snapshot);
    const seed = "ff".repeat(32);
    expect(createCommitment(seed, hash)).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 20; i++) {
      const idx = drawWinnerIndex(seed + String(i), hash, 3);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
    expect(() => computeDraw([])).toThrow();
  });
});
