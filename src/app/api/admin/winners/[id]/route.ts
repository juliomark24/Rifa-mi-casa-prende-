// PATCH /api/admin/winners/[id] — avanza el caso del ganador (S7).
// Cuerpo estandarizado: {status, evidence?, note?} + opcionales S7:
// {contactChannel?, outcome?, deadlineDays?}.
//  - status: avanza UN paso del flujo de 7 estados (o mismo estado para
//    añadir evidencia/nota). Saltarse pasos, retroceder o tocar un caso
//    cerrado → 409. Cerrar exige evidencia de entrega; al cerrar, la rifa
//    pasa a FINALIZADA si estaba en GANADOR_PUBLICADO.
//  - outcome: procedimiento de las bases (NO_ELEGIBLE | RENUNCIA |
//    SIN_RESPUESTA | ENTREGA_IMPOSIBLE). Se registra en notas; el caso
//    PERMANECE ABIERTO y la rifa NO se finaliza. Puede combinarse con status
//    o ir solo (sin status).
// "Ganador publicado" es independiente de "premio entregado / caso cerrado".
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse } from "@/lib/errors";
import { parseBody, winnerPatchSchema } from "@/lib/validate";
import {
  advanceWinnerCase,
  recordWinnerOutcome,
  WINNER_OUTCOMES,
  type WinnerOutcome,
} from "@/lib/winner";

const winnerPatchExtendedSchema = winnerPatchSchema
  .extend({
    status: winnerPatchSchema.shape.status.optional(),
    contactChannel: z.string().trim().min(1).max(64).optional(),
    outcome: z.enum(WINNER_OUTCOMES).optional(),
    deadlineDays: z.number().int().positive().max(365).optional(),
  })
  .refine((b) => b.status !== undefined || b.outcome !== undefined, {
    message: "Se requiere status o outcome",
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "winners.manage");
    const body = await parseBody(req, winnerPatchExtendedSchema);
    const before = await db.winnerCase.findUnique({ where: { id } });
    if (!before) return NextResponse.json({ error: "Caso de ganador no existe" }, { status: 404 });
    if (body.outcome && !body.note) {
      throw badRequest("El procedimiento de las bases requiere una nota que describa lo ocurrido");
    }

    // 1) Procedimiento de las bases (si viene outcome): registra, no avanza.
    if (body.outcome) {
      await recordWinnerOutcome(id, body.outcome as WinnerOutcome, {
        note: body.note as string,
        evidence: body.evidence,
        contactChannel: body.contactChannel,
        deadlineDays: body.deadlineDays,
      });
    }
    // 2) Avance de estado (si viene status): un paso del flujo.
    let updated = await db.winnerCase.findUniqueOrThrow({ where: { id } });
    if (body.status) {
      await advanceWinnerCase(id, {
        status: body.status,
        evidence: body.evidence,
        note: body.outcome ? undefined : body.note,
        contactChannel: body.contactChannel,
      });
      updated = await db.winnerCase.findUniqueOrThrow({ where: { id } });
    }
    await logAudit({
      actorId: user.id,
      action: "winners.update",
      entity: "WinnerCase",
      entityId: id,
      before: { status: before.status },
      after: {
        status: updated.status,
        outcome: body.outcome ?? null,
        note: body.note ?? null,
      },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
