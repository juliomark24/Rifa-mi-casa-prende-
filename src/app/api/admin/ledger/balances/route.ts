// GET /api/admin/ledger/balances — saldos por cuenta (plan §2.3):
// ventas, reembolsos, contracargos, costos, comisiones (por estado,
// comprometidas, disponibles, pagadas), retiros, reservas, en disputa.
// Permiso reports.view. ?currency=DOP (defecto: primera moneda con
// movimientos, o DOP si no hay), ?from= & ?to= (ISO).
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { getLedgerBalances, ledgerCurrencies } from "@/lib/ledger";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "reports.view");
    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    let currency = url.searchParams.get("currency") ?? undefined;
    if (!currency) {
      const currencies = await ledgerCurrencies(db);
      currency = currencies[0] ?? "DOP";
    }
    const balances = await getLedgerBalances(db, {
      currency,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return NextResponse.json(balances);
  } catch (err) {
    return errorResponse(err);
  }
}
