// GET /api/admin/recovery-requests — lista solicitudes de recuperación
// (permiso recovery.approve). Nunca expone hashes ni códigos.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "recovery.approve");
    const requests = await db.recoveryRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        userId: true,
        status: true,
        reason: true,
        expiresAt: true,
        approvedById: true,
        approvedAt: true,
        completedAt: true,
        createdAt: true,
        user: { select: { name: true, email: true, role: true } },
      },
    });
    return NextResponse.json({ data: requests });
  } catch (err) {
    return errorResponse(err);
  }
}
