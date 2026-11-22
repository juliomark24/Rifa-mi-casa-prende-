// POST /api/auth/logout — revoca la sesión actual.
import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, requireAuth, revokeSession } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";

export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await requireAuth(req);
    await revokeSession(sessionId);
    const res = NextResponse.json({ ok: true });
    clearSessionCookie(res);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
