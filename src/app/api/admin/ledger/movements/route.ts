// GET /api/admin/ledger/movements — movimientos del ledger por rango de
// fechas, con filtros y paginación. Permiso reports.view.
// ?currency=&type=VENTA|COMISION|REEMBOLSO|CONTRACARGO|COSTO|RETIRO|RESERVA|AJUSTE
// &refType=&refId=&from=&to=&page=&limit=
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { getLedgerMovements } from "@/lib/ledger";

const LEDGER_TYPES = ["VENTA", "COMISION", "REEMBOLSO", "CONTRACARGO", "COSTO", "RETIRO", "RESERVA", "AJUSTE"] as const;

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "reports.view");
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (type && !(LEDGER_TYPES as readonly string[]).includes(type)) {
      return NextResponse.json({ error: `type inválido: ${type}` }, { status: 400 });
    }
    const result = await getLedgerMovements(db, {
      currency: url.searchParams.get("currency") ?? undefined,
      type: type as (typeof LEDGER_TYPES)[number] | undefined,
      refType: url.searchParams.get("refType") ?? undefined,
      refId: url.searchParams.get("refId") ?? undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      page: Number(url.searchParams.get("page") ?? "1") || 1,
      limit: Number(url.searchParams.get("limit") ?? "20") || 20,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
