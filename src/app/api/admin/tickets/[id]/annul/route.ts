// POST /api/admin/tickets/[id]/annul — anula un boleto con motivo
// obligatorio (permiso tickets.manage). Si el boleto estaba pagado,
// la respuesta marca refundRequired: true (el reembolso lo ejecuta S6).
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { annulSchema, annulTicket } from "@/lib/tickets";
import { parseBody } from "@/lib/validate";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "tickets.manage");
    const body = await parseBody(req, annulSchema);
    const result = await annulTicket(id, user.id, body.reason);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
