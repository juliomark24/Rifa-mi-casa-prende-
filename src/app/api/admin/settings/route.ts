// GET / PATCH /api/admin/settings — parámetros del sistema (contrato v2.2).
// S9-int: la ruta no existía aunque el contrato la define y el panel de
// Configuración (SettingsForm) la usa. GET devuelve los ajustes guardados
// + los valores por defecto de las claves conocidas que aún no existen;
// PATCH guarda la lista {settings: [{key, value}]} con validación zod.
// Claves conocidas (las que lee el código): COMMISSION_RATE (por ciento),
// RETENTION_DAYS, MIN_WITHDRAWAL, RESERVATION_MINUTES,
// WITHDRAWAL_DOUBLE_APPROVAL_THRESHOLD, AFFILIATE_ATTRIBUTION_DAYS y los
// umbrales de fraude FRAUD_*. Todo cambio queda en auditoría.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { parseBody } from "@/lib/validate";

const KNOWN_DEFAULTS: Record<string, string> = {
  COMMISSION_RATE: "10",
  RETENTION_DAYS: "7",
  MIN_WITHDRAWAL: "500",
  RESERVATION_MINUTES: "10",
  WITHDRAWAL_DOUBLE_APPROVAL_THRESHOLD: "10000",
  AFFILIATE_ATTRIBUTION_DAYS: "7",
  FRAUD_VELOCITY_MAX_ORDERS: "5",
  FRAUD_VELOCITY_WINDOW_MINUTES: "60",
  FRAUD_VELOCITY_MAX_TICKETS: "20",
  FRAUD_MAX_REFUNDS: "2",
  FRAUD_REFUND_WINDOW_DAYS: "90",
  FRAUD_MAX_CHARGEBACKS: "1",
};

/** Claves con valor entero no negativo (COMMISSION_RATE además ≤ 100). */
const INTEGER_KEYS = new Set(Object.keys(KNOWN_DEFAULTS));

const settingsPatchSchema = z.object({
  settings: z
    .array(
      z.object({
        key: z
          .string()
          .trim()
          .regex(/^[A-Z][A-Z0-9_]*$/, "La clave debe ser MAYUSCULAS_CON_GUIONES_BAJOS")
          .max(64),
        value: z.string().max(2000),
      }),
    )
    .min(1, "Envía al menos un ajuste")
    .max(100),
});

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "settings.view");
    const stored = await db.setting.findMany({ orderBy: { key: "asc" } });
    const byKey = new Map(stored.map((s) => [s.key, s.value]));
    const settings = [
      ...stored.map((s) => ({ key: s.key, value: s.value })),
      ...Object.entries(KNOWN_DEFAULTS)
        .filter(([key]) => !byKey.has(key))
        .map(([key, value]) => ({ key, value })),
    ].sort((a, b) => a.key.localeCompare(b.key));
    return NextResponse.json({ settings });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { user } = await requirePermission(req, "settings.edit");
    const body = await parseBody(req, settingsPatchSchema);
    for (const s of body.settings) {
      if (INTEGER_KEYS.has(s.key)) {
        const n = Number(s.value);
        if (!Number.isInteger(n) || n < 0) {
          throw badRequest(`El ajuste ${s.key} debe ser un entero no negativo`);
        }
        if (s.key === "COMMISSION_RATE" && n > 100) {
          throw badRequest("COMMISSION_RATE es un por ciento (0-100)");
        }
      }
    }
    const before = await db.setting.findMany({
      where: { key: { in: body.settings.map((s) => s.key) } },
    });
    const beforeMap = new Map(before.map((s) => [s.key, s.value]));
    for (const s of body.settings) {
      await db.setting.upsert({
        where: { key: s.key },
        update: { value: s.value },
        create: { key: s.key, value: s.value },
      });
    }
    await logAudit({
      actorId: user.id,
      action: "settings.update",
      entity: "Setting",
      after: {
        changed: body.settings.map((s) => ({ key: s.key, before: beforeMap.get(s.key) ?? null, after: s.value })),
      },
    });
    const stored = await db.setting.findMany({ orderBy: { key: "asc" } });
    return NextResponse.json({ settings: stored.map((s) => ({ key: s.key, value: s.value })) });
  } catch (err) {
    return errorResponse(err);
  }
}
