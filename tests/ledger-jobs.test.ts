// Ledger append-only, idempotencia y jobs resistentes.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { withIdempotency } from "../src/lib/idempotency";
import { getLastJobRun, runJob } from "../src/lib/jobs";
import { appendLedgerEntry, ledgerBalance, ledgerEntriesFor } from "../src/lib/ledger";
import { cleanDb } from "./helpers";

describe("ledger append-only", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("append + saldos derivados; un reembolso compensa la venta", async () => {
    await appendLedgerEntry(db, { type: "VENTA", amount: 1000, currency: "DOP", refType: "Order", refId: "ORD-1" });
    await appendLedgerEntry(db, { type: "COMISION", amount: 100, currency: "DOP", refType: "Order", refId: "ORD-1" });
    expect(await ledgerBalance(db, { refType: "Order", refId: "ORD-1" })).toBe(1100);
    expect(await ledgerBalance(db, { refType: "Order", refId: "ORD-1", type: "VENTA" })).toBe(1000);
    // Corrección con asiento compensatorio (nunca editando el original).
    await appendLedgerEntry(db, { type: "REEMBOLSO", amount: -1000, currency: "DOP", refType: "Order", refId: "ORD-1", metadata: { compensates: "venta" } });
    expect(await ledgerBalance(db, { refType: "Order", refId: "ORD-1", type: "VENTA" })).toBe(1000);
    expect((await ledgerEntriesFor(db, "Order", "ORD-1")).length).toBe(3);
  });

  it("rechaza montos no enteros", async () => {
    await expect(
      appendLedgerEntry(db, { type: "VENTA", amount: 10.5, currency: "DOP", refType: "Order", refId: "X" }),
    ).rejects.toThrow();
  });
});

describe("idempotencia", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("repetir la misma clave no re-ejecuta la operación", async () => {
    let calls = 0;
    const op = async () => {
      calls += 1;
      return { orderId: "ORD-1", total: 500 };
    };
    const first = await withIdempotency("order", "key-123", op);
    const second = await withIdempotency("order", "key-123", op);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
    const otherScope = await withIdempotency("payment", "key-123", op);
    expect(otherScope).toEqual({ orderId: "ORD-1", total: 500 });
    expect(calls).toBe(2); // mismo key, distinto scope: operación distinta
  });
});

describe("jobs resistentes", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("registra JobRun COMPLETED con resultado y es re-ejecutable", async () => {
    const r1 = await runJob("test-job", async () => ({ ok: true, processed: 3 }));
    expect(r1.status).toBe("COMPLETED");
    const last = await getLastJobRun("test-job");
    expect(last?.status).toBe("COMPLETED");
    const r2 = await runJob("test-job", async () => ({ ok: true, processed: 0 }));
    expect(r2.status).toBe("COMPLETED");
    expect(await db.jobRun.count({ where: { job: "test-job" } })).toBe(2);
  });

  it("un job que falla queda FAILED con el error y se puede reintentar", async () => {
    await expect(
      runJob("failing-job", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const last = await getLastJobRun("failing-job");
    expect(last?.status).toBe("FAILED");
    expect(last?.error).toBe("boom");
    const retry = await runJob("failing-job", async () => ({ ok: true }));
    expect(retry.status).toBe("COMPLETED");
  });

  it("una ejecución RUNNING reciente hace skip (sin duplicar)", async () => {
    await db.jobRun.create({ data: { job: "busy-job", status: "RUNNING" } });
    const res = await runJob("busy-job", async () => ({ ok: true }));
    expect(res.skipped).toBe(true);
    expect(await db.jobRun.count({ where: { job: "busy-job" } })).toBe(1);
  });
});
