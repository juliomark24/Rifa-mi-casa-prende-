// POST /api/admin/tickets/[id]/unblock — desbloquea un boleto BLOCKED
// (permiso tickets.manage): vuelve a DISPONIBLE.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { unblockTicket } from "@/lib/tickets";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(_req, "tickets.manage");
    const ticket = await unblockTicket(id, user.id);
    return NextResponse.json({ ticket });
  } catch (err) {
    return errorResponse(err);
  }
}
