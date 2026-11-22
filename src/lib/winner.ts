// Gestión del ganador (plan §2.15, aclaración 2).
//
// "Ganador publicado" es INDEPENDIENTE de "premio entregado / caso cerrado":
// publicar el resultado NO implica entrega. El caso solo se cierra con
// entrega registrada (evidencia: fotos/acta, fecha y responsable). La rifa
// pasa a FINALIZADA solo cuando el caso está CASO_CERRADO.
//
// Flujo de 7 estados (lineal, un paso a la vez; CASO_CERRADO es terminal):
//   PENDIENTE_CONTACTO → CONTACTADO → VERIFICACION → PREMIO_ACEPTADO
//   → ENTREGA_COORDINADA → ENTREGADO → CASO_CERRADO
// Un PATCH con el mismo estado es un no-op idempotente (permite añadir
// evidencia/nota sin avanzar). Retroceder o saltarse pasos se rechaza (409).
//
// Procedimientos de las bases (§2.15): ganador no elegible, renuncia,
// no responde (plazo según bases) e imposibilidad de entrega. Se registran
// con recordWinnerOutcome(): el caso PERMANECE ABIERTO y la resolución queda
// escrita en notas + registro de contactos; nunca una decisión informal y
// nunca un cierre sin entrega. La decisión de qué hacer después (suplente,
// nuevo sorteo según bases) la toma el responsable y queda registrada.
import { db, type Tx } from "./db";
import { conflict, notFound } from "./errors";

export const WINNER_FLOW = [
  "PENDIENTE_CONTACTO",
  "CONTACTADO",
  "VERIFICACION",
  "PREMIO_ACEPTADO",
  "ENTREGA_COORDINADA",
  "ENTREGADO",
  "CASO_CERRADO",
] as const;

export type WinnerCaseStatus = (typeof WINNER_FLOW)[number];

/** Siguiente estado permitido desde cada estado (null = terminal). */
export const WINNER_NEXT: Record<WinnerCaseStatus, WinnerCaseStatus | null> = {
  PENDIENTE_CONTACTO: "CONTACTADO",
  CONTACTADO: "VERIFICACION",
  VERIFICACION: "PREMIO_ACEPTADO",
  PREMIO_ACEPTADO: "ENTREGA_COORDINADA",
  ENTREGA_COORDINADA: "ENTREGADO",
  ENTREGADO: "CASO_CERRADO",
  CASO_CERRADO: null,
};

export const WINNER_OUTCOMES = [
  "NO_ELEGIBLE",
  "RENUNCIA",
  "SIN_RESPUESTA",
  "ENTREGA_IMPOSIBLE",
] as const;

export type WinnerOutcome = (typeof WINNER_OUTCOMES)[number];

/** Procedimiento de las bases para cada desenlace (texto que queda registrado). */
export const WINNER_OUTCOME_LABELS: Record<WinnerOutcome, string> = {
  NO_ELEGIBLE: "Ganador no elegible",
  RENUNCIA: "Ganador renuncia al premio",
  SIN_RESPUESTA: "Ganador no responde (plazo según bases)",
  ENTREGA_IMPOSIBLE: "Imposibilidad de entrega",
};

export function isWinnerCaseStatus(value: unknown): value is WinnerCaseStatus {
  return typeof value === "string" && (WINNER_FLOW as readonly string[]).includes(value);
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** Fusiona evidencia nueva con la guardada (objeto con objeto; resto reemplaza). */
export function mergeEvidence(oldEvidence: unknown, newEvidence: unknown): unknown {
  if (newEvidence === undefined) return oldEvidence ?? null;
  const oldObj = asObject(oldEvidence);
  const newObj = asObject(newEvidence);
  if (Object.keys(newObj).length > 0) return { ...oldObj, ...newObj };
  return newEvidence;
}

export type ContactEntry = { at: string; channel: string; note?: string };

export function appendContactLog(oldLog: unknown, entry: ContactEntry): ContactEntry[] {
  const log = Array.isArray(oldLog) ? (oldLog as ContactEntry[]) : [];
  return [...log, entry];
}

/**
 * ¿La evidencia acredita una entrega? Se exige para CASO_CERRADO.
 * Forma estructurada: (fotos no vacías o acta) + fecha de entrega +
 * responsable. Forma de texto libre: descripción de la entrega de al menos
 * 10 caracteres (p. ej. "Acta firmada el 21/11/2026 por ...").
 */
export function hasDeliveryEvidence(evidence: unknown): boolean {
  if (typeof evidence === "string") return evidence.trim().length >= 10;
  const obj = asObject(evidence);
  if (Object.keys(obj).length === 0) return false;
  const delivery = asObject(obj.delivery);
  const photos = obj.photos ?? delivery.photos;
  const acta = obj.acta ?? delivery.acta;
  const date = obj.deliveryDate ?? obj.deliveredAt ?? delivery.deliveryDate ?? delivery.deliveredAt;
  const responsible = obj.responsible ?? obj.deliveredBy ?? delivery.responsible ?? delivery.deliveredBy;
  const hasProof =
    (Array.isArray(photos) && photos.length > 0) ||
    (typeof acta === "string" && acta.trim().length > 0);
  return hasProof && date !== undefined && date !== null && String(date).trim().length > 0 &&
    responsible !== undefined && responsible !== null && String(responsible).trim().length > 0;
}

export type AdvanceWinnerInput = {
  status: WinnerCaseStatus;
  evidence?: unknown;
  note?: string;
  contactChannel?: string;
};

/**
 * Avanza el caso un paso del flujo (o actualiza evidencia/nota sin avanzar).
 * Cerrar exige evidencia de entrega. Al cerrar, si la rifa está en
 * GANADOR_PUBLICADO pasa a FINALIZADA. Todo en una transacción.
 */
export async function advanceWinnerCase(
  caseId: string,
  input: AdvanceWinnerInput,
  tx: Tx | typeof db = db,
): Promise<{ id: string; raffleId: string; status: WinnerCaseStatus }> {
  const before = await tx.winnerCase.findUnique({ where: { id: caseId } });
  if (!before) throw notFound("Caso de ganador no existe");
  const current = before.status as WinnerCaseStatus;
  if (current === "CASO_CERRADO") {
    throw conflict("El caso ya está cerrado; un caso cerrado no se puede modificar");
  }
  const target = input.status;
  const isSame = target === current;
  const isNext = WINNER_NEXT[current] === target;
  if (!isSame && !isNext) {
    const next = WINNER_NEXT[current];
    throw conflict(
      next
        ? `Transición no permitida: de ${current} solo se puede avanzar a ${next}`
        : `Transición no permitida: ${current} es un estado terminal`,
    );
  }
  const evidence = mergeEvidence(before.evidence, input.evidence);
  if (target === "CASO_CERRADO" && !hasDeliveryEvidence(evidence)) {
    throw conflict(
      "No se puede cerrar el caso sin entrega registrada: falta evidencia de entrega (fotos o acta, fecha y responsable)",
    );
  }
  const notes = input.note
    ? before.notes
      ? `${before.notes}\n${input.note}`
      : input.note
    : before.notes;
  const contactLog =
    input.contactChannel && target === "CONTACTADO"
      ? appendContactLog(before.contactLog, {
          at: new Date().toISOString(),
          channel: input.contactChannel,
          note: input.note,
        })
      : before.contactLog;
  const run = async (client: Tx | typeof db) => {
    const updated = await client.winnerCase.update({
      where: { id: caseId },
      data: {
        status: target,
        evidence: (evidence ?? undefined) as never,
        notes: notes ?? undefined,
        contactLog: (contactLog ?? undefined) as never,
      },
    });
    if (target === "CASO_CERRADO") {
      // La rifa solo se finaliza cuando el caso está cerrado (aclaración 2).
      await client.raffle.updateMany({
        where: { id: before.raffleId, status: "GANADOR_PUBLICADO" },
        data: { status: "FINALIZADA" },
      });
    }
    return updated;
  };
  // Si quien llama ya está en transacción, operar dentro de ella.
  const updated = tx === db ? await db.$transaction((inner) => run(inner)) : await run(tx);
  return { id: updated.id, raffleId: updated.raffleId, status: updated.status as WinnerCaseStatus };
}

export type RecordOutcomeInput = {
  note: string;
  evidence?: unknown;
  contactChannel?: string;
  deadlineDays?: number;
};

/**
 * Registra un procedimiento de las bases (no elegible, renuncia, sin
 * respuesta, entrega imposible). El caso permanece ABIERTO: el estado no
 * cambia y la rifa NO se finaliza. La resolución queda en notas y, si hay
 * canal, en el registro de contactos. Lanza 409 si el caso está cerrado.
 */
export async function recordWinnerOutcome(
  caseId: string,
  outcome: WinnerOutcome,
  input: RecordOutcomeInput,
  tx: Tx | typeof db = db,
): Promise<{ id: string; raffleId: string; status: WinnerCaseStatus }> {
  const before = await tx.winnerCase.findUnique({ where: { id: caseId } });
  if (!before) throw notFound("Caso de ganador no existe");
  if (before.status === "CASO_CERRADO") {
    throw conflict("El caso ya está cerrado; no se puede registrar un procedimiento sobre él");
  }
  const label = WINNER_OUTCOME_LABELS[outcome];
  const deadline =
    outcome === "SIN_RESPUESTA" && input.deadlineDays
      ? ` Plazo aplicado según bases: ${input.deadlineDays} día(s).`
      : "";
  const entry =
    `[PROCEDIMIENTO — ${label}] ${input.note}${deadline} ` +
    `El caso permanece abierto hasta que el responsable registre la resolución según las bases.`;
  const notes = before.notes ? `${before.notes}\n${entry}` : entry;
  const evidence = mergeEvidence(before.evidence, input.evidence);
  const contactLog = input.contactChannel
    ? appendContactLog(before.contactLog, {
        at: new Date().toISOString(),
        channel: input.contactChannel,
        note: `${label}: ${input.note}`,
      })
    : before.contactLog;
  const run = async (client: Tx | typeof db) =>
    client.winnerCase.update({
      where: { id: caseId },
      data: {
        notes,
        evidence: (evidence ?? undefined) as never,
        contactLog: (contactLog ?? undefined) as never,
      },
    });
  const updated = tx === db ? await db.$transaction((inner) => run(inner)) : await run(tx);
  return { id: updated.id, raffleId: updated.raffleId, status: updated.status as WinnerCaseStatus };
}
