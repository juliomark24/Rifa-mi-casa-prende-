// /api/admin/terms — versiones de bases (plan §2.18).
// GET ?raffleId= — lista versiones de una rifa (o todas).
// POST {raffleId, content} — crea una nueva versión (n+1) y la marca como
// vigente en la rifa. Las versiones viejas nunca se editan ni se borran.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { createTermsVersion } from "@/lib/terms";
import { parseBody, termsCreateSchema } from "@/lib/validate";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "raffles.view");
    const raffleId = req.nextUrl.searchParams.get("raffleId");
    const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "20") || 20));
    const where = raffleId ? { raffleId } : {};
    const [total, terms] = await Promise.all([
      db.raffleTerms.count({ where }),
      db.raffleTerms.findMany({
        where,
        orderBy: [{ raffleId: "asc" }, { version: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return NextResponse.json({ data: terms, page, total });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requirePermission(req, "raffles.edit");
    const body = await parseBody(req, termsCreateSchema);
    const terms = await createTermsVersion({
      raffleId: body.raffleId,
      content: body.content,
      createdById: user.id,
    });
    await logAudit({
      actorId: user.id,
      action: "raffles.terms.create",
      entity: "RaffleTerms",
      entityId: terms.id,
      after: { raffleId: body.raffleId, version: terms.version },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: terms }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
