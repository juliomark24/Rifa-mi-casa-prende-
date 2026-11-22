// POST /api/admin/tickets/[id]/block — bloquea un boleto DISPONIBLE
// (permiso tickets.manage). No se vende mientras esté bloqueado.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { blockTicket } from "@/lib/tickets";
import { parseBody } from "@/lib/validate";
import { z } from "zod";

const bodySchema = z.object({ reason: z.string().trim().max(2000).optional() });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "tickets.manage");
    const body = await parseBody(req, bodySchema).catch(() => ({ reason: undefined }));
    const ticket = await blockTicket(id, user.id, body.reason);
    return NextResponse.json({ ticket });
  } catch (err) {
    return errorResponse(err);
  }
}
