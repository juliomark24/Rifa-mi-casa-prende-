// Audit log inmutable (plan §2.8, §2.20): quién, cuándo, qué, antes/después.
// Toda acción administrativa sensible pasa por aquí.
import { Prisma } from "../generated/prisma/client";
import { db } from "./db";

/** Normaliza un valor a JSON válido de Prisma (null → Prisma.JsonNull). */
export function toJsonValue(
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export type AuditInput = {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
};

export async function logAudit(input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        before: toJsonValue(input.before),
        after: toJsonValue(input.after),
        ipAddress: input.ipAddress ?? null,
      },
    });
  } catch (err) {
    // La auditoría nunca debe romper la operación que registra.
    console.error("[audit] no se pudo registrar:", err);
  }
}

// ---------------------------------------------------------------- control de cambios (§2.20)
// Todo cambio sensible registra antes/después, motivo y aprobación cuando
// corresponde. Sin registro no se aplica el cambio (P28). Los valores se
// guardan como texto (el modelo ChangeLog usa String, no Json).
export type ChangeInput = {
  actorId?: string | null;
  entity: string;
  entityId: string;
  field?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string | null;
  approvedById?: string | null;
};

function changeValueToString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export async function logChange(input: ChangeInput): Promise<void> {
  try {
    await db.changeLog.create({
      data: {
        actorId: input.actorId ?? null,
        entity: input.entity,
        entityId: input.entityId,
        field: input.field ?? null,
        beforeValue: changeValueToString(input.beforeValue),
        afterValue: changeValueToString(input.afterValue),
        reason: input.reason ?? null,
        approvedById: input.approvedById ?? null,
      },
    });
  } catch (err) {
    // El registro de cambios nunca debe romper la operación que registra.
    console.error("[change-log] no se pudo registrar:", err);
  }
}

/** Extrae la IP del cliente desde los headers (detrás de proxy). */
export function getClientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}
