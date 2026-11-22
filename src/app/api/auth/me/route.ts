// GET /api/auth/me — usuario actual + roles/permisos.
import { NextRequest, NextResponse } from "next/server";
import { publicUser, requireAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireAuth(req);
    return NextResponse.json({
      user: { ...publicUser(user), mustReenroll2fa: user.mustReenroll2fa },
      permissions: ROLE_PERMISSIONS[user.role],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
