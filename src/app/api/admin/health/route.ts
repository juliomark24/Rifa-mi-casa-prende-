// GET /api/admin/health — estado del sistema (plan §2.19, contrato).
// { status, database, jobs, queues, lastBackupAt, recentErrors, alerts }.
// Permiso monitoring.view (lectura; AUDITOR incluido).
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getSystemHealth } from "@/lib/monitoring";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "monitoring.view");
    const health = await getSystemHealth();
    return NextResponse.json(health);
  } catch (err) {
    return errorResponse(err);
  }
}
