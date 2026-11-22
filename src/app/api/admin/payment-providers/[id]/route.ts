// GET / PATCH /api/admin/payment-providers/[id]
// Configurar un proveedor desde el panel (sin tocar código):
//  - sandboxMode, credentialsRef (SOLO referencia segura, nunca el secreto),
//    authorizedForRaffles, notes.
//  - status: solo se permite desactivar (NO_OPERATIVO) por PATCH. Activar
//    exige el gate de POST .../activate (regla 6).
// Cualquier intento de enviar un secreto en claro (apiKey, secret, password,
// clientSecret, token) se rechaza con 400. Todo cambio queda en auditoría
// y en ConfigHistory.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { badRequest, errorResponse } from "@/lib/errors";
import { mergeProviderCredentials, sanitizeProvider } from "@/lib/payments/registry";
import { providerPatchSchema } from "@/lib/validate";

const FORBIDDEN_BODY_KEYS = ["apikey", "api_key", "secret", "password", "clientsecret", "token"];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requirePermission(req, "paymentProviders.view");
    const provider = await db.paymentProvider.findUnique({
      where: { id },
      include: {
        configs: {
          include: { country: { select: { code: true, name: true } }, method: { select: { code: true, label: true } } },
        },
      },
    });
    if (!provider) return NextResponse.json({ error: "Proveedor no existe" }, { status: 404 });
    return NextResponse.json({ data: sanitizeProvider(provider) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requirePermission(req, "paymentProviders.manage");
    const raw = (await req.json()) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      // El canal autorizado para secretos es {credentials:{...}} (cifrado
      // en BD, nunca devuelto). Secretos sueltos en el body → 400.
      if (key === "credentials") continue;
      if (FORBIDDEN_BODY_KEYS.includes(key.toLowerCase().replace(/[_-]/g, ""))) {
        throw badRequest(
          "No envíes secretos sueltos en el body. Usa {credentials:{...}} (se cifran y nunca se devuelven) o credentialsRef con una referencia segura.",
        );
      }
    }
    const parsed = providerPatchSchema.safeParse(raw);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? "Datos inválidos");
    }
    const body = parsed.data;
    const before = await db.paymentProvider.findUnique({ where: { id } });
    if (!before) return NextResponse.json({ error: "Proveedor no existe" }, { status: 404 });

    // Credenciales del panel: solo campos no vacíos, cifradas, fusionadas
    // con las guardadas. Nunca se devuelven valores.
    let credentialsUpdate: { encrypted: string; ref: string } | null = null;
    if (body.credentials !== undefined) {
      try {
        credentialsUpdate = mergeProviderCredentials(before.credentialsEncrypted ?? null, body.credentials);
      } catch (e) {
        throw badRequest(e instanceof Error ? e.message : "Credenciales inválidas");
      }
    }

    const updated = await db.paymentProvider.update({
      where: { id },
      data: {
        sandboxMode: body.sandboxMode,
        credentialsRef: credentialsUpdate?.ref ?? body.credentialsRef,
        credentialsEncrypted: credentialsUpdate?.encrypted,
        authorizedForRaffles: body.authorizedForRaffles,
        notes: body.notes,
        status: body.status, // solo NO_OPERATIVO (validado por el schema)
        verifiedAt: body.status === "NO_OPERATIVO" ? null : undefined,
      },
    });
    await db.configHistory.create({
      data: {
        entity: "PaymentProvider",
        entityId: id,
        changedById: user.id,
        before: { status: before.status, sandboxMode: before.sandboxMode, credentialsRef: before.credentialsRef, authorizedForRaffles: before.authorizedForRaffles } as object,
        after: { status: updated.status, sandboxMode: updated.sandboxMode, credentialsRef: updated.credentialsRef, authorizedForRaffles: updated.authorizedForRaffles } as object,
        reason: "Configuración desde el panel admin",
      },
    });
    await logAudit({
      actorId: user.id,
      action: "payments.provider.update",
      entity: "PaymentProvider",
      entityId: id,
      before: { status: before.status },
      after: { status: updated.status, credentialsConfigured: Boolean(credentialsUpdate ?? before.credentialsEncrypted) },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ data: sanitizeProvider(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}
