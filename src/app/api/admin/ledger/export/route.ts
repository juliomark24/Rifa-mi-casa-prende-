// GET /api/admin/ledger/export — exportación de movimientos a CSV.
// Permiso reports.view. Mismos filtros que /movements, sin paginación
// (máx 10.000 filas). Responde text/csv con Content-Disposition attachment.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { getLedgerMovements, ledgerMovementsToCsv } from "@/lib/ledger";

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
      page: 1,
      limit: 100,
    });
    // La exportación no pagina: si hay más de 100 filas, se exportan en
    // bloques hasta 10.000 (límite de seguridad de la exportación).
    const all = [...result.data];
    let page = 2;
    while (result.total > all.length && all.length < 10000) {
      const next = await getLedgerMovements(db, {
        currency: url.searchParams.get("currency") ?? undefined,
        type: type as (typeof LEDGER_TYPES)[number] | undefined,
        refType: url.searchParams.get("refType") ?? undefined,
        refId: url.searchParams.get("refId") ?? undefined,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        page,
        limit: 100,
      });
      all.push(...next.data);
      page += 1;
    }
    const csv = ledgerMovementsToCsv(all);
    const filename = `ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
