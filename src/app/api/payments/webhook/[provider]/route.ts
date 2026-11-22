// POST /api/payments/webhook/[provider] — webhooks de pasarela
// (contrato API-CONTRACT-v2.2.md; plan §2.2, P4).
//
// Orden estricto, sin atajos:
//  1. Proveedor desconocido → 404. Transferencia manual → 400 (no tiene
//     webhooks: la verifica un admin).
//  2. Proveedor sin fila en BD o con estado distinto de OPERATIVO → 503
//     NOT_CONFIGURED (regla 6: ninguna pasarela es operativa hasta
//     verificar integración real + autorización para rifas + conciliación).
//  3. Firma verificada contra el CUERPO CRUDO con el adaptador real
//     (HMAC-SHA256 Azul/CardNet; API verify-webhook-signature PayPal).
//     Sin firma válida → 401, sin efectos (el intento queda registrado
//     como WebhookEvent rechazado para auditoría de webhooks rechazados).
//  4. Evento procesado con idempotencia (proveedor, eventId): un duplicado
//     devuelve 200 `duplicate: true` sin repetir efectos.
//  5. Sin eventId no se puede dedupar → 400, sin efectos.
//
// La ruta no conoce la lógica de negocio: delega en
// `processWebhookEvent` (src/lib/payments/webhooks.ts).
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { errorResponse, notConfigured } from "@/lib/errors";
import {
  getAdapter,
  getProviderCredentials,
  webhookProviderCode,
} from "@/lib/payments/registry";
import { processWebhookEvent } from "@/lib/payments/webhooks";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider: slug } = await params;
    if (slug.trim().toLowerCase() === "manual_transfer" || slug.trim().toLowerCase() === "manual-transfer") {
      return NextResponse.json(
        { error: "La transferencia manual no tiene webhooks: la verifica un administrador", code: "NO_WEBHOOK" },
        { status: 400 },
      );
    }
    const code = webhookProviderCode(slug);
    if (!code) {
      return NextResponse.json({ error: `Proveedor desconocido: ${slug}`, code: "NOT_FOUND" }, { status: 404 });
    }
    // Regla 6: solo un proveedor OPERATIVO acepta webhooks.
    const row = await db.paymentProvider.findUnique({ where: { code } });
    if (!row || row.status !== "OPERATIVO") {
      throw notConfigured(
        `Proveedor ${code} NO operativo: sin integración real verificada, sin autorización para rifas y sin conciliación (regla 6 del plan v2.2).`,
      );
    }
    const rawBody = await req.text();
    const adapter = getAdapter(code);
    const credentials = await getProviderCredentials(code);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const signature =
      req.headers.get("x-signature") ??
      req.headers.get("x-webhook-signature") ??
      req.headers.get("paypal-transmission-sig") ??
      "";
    let valid: boolean;
    try {
      valid = await adapter.verifyWebhookSignature(rawBody, signature, {
        secret: credentials?.webhookSecret,
        headers,
        credentials: credentials ?? undefined,
      });
    } catch (err) {
      // Sin secreto/credenciales que verificar: 503, no 401 (regla 6).
      return errorResponse(err);
    }
    if (!valid) {
      // Intento rechazado: queda registrado (auditoría §2.19) sin efectos.
      const rejectedId = `rejected-${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
      await db.webhookEvent
        .create({
          data: {
            provider: code,
            eventId: rejectedId,
            payload: { rawBodyHash: rejectedId, note: "firma inválida" } as never,
            error: "Firma de webhook inválida",
          },
        })
        .catch(() => undefined);
      return NextResponse.json(
        { error: "Firma de webhook inválida", code: "INVALID_WEBHOOK_SIGNATURE" },
        { status: 401 },
      );
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "Cuerpo del webhook no es JSON válido", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    const eventId =
      typeof body.id === "string" && body.id.trim() !== ""
        ? body.id.trim()
        : typeof body.eventId === "string" && body.eventId.trim() !== ""
          ? body.eventId.trim()
          : typeof body.event_id === "string" && body.event_id.trim() !== ""
            ? body.event_id.trim()
            : null;
    if (!eventId) {
      return NextResponse.json(
        { error: "El webhook no trae id de evento (no se puede dedupar)", code: "WEBHOOK_EVENT_ID_REQUIRED" },
        { status: 400 },
      );
    }
    const result = await processWebhookEvent({
      provider: code,
      eventId,
      eventType:
        typeof body.type === "string"
          ? body.type
          : typeof body.event === "string"
            ? body.event
            : typeof body.status === "string"
              ? body.status
              : null,
      payload: body,
      adapter,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
