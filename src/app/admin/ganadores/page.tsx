export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { WinnerCase } from "@/components/types";
import { formatDate, statusLabel } from "@/components/format";
import { WinnerCaseActions } from "@/components/AdminCaseActions";

/**
 * Gestión del caso del ganador (plan §2.15): 7 estados, contacto,
 * verificación, aceptación, entrega coordinada, entregado, caso cerrado.
 * GET /api/admin/winners · PATCH /api/admin/winners/[id].
 * "Ganador publicado" es independiente de "premio entregado / caso cerrado".
 *
 * S9-int: la API devuelve `evidence` como JSON (objeto) y el contacto en
 * `contactLog` (lista); la página anterior renderizaba `evidence` como
 * texto ([object Object]) y leía `contactedAt`/`contactChannel`, campos
 * que la API no devuelve. Ahora se resumen desde los campos reales.
 */
function evidenceSummary(evidence: WinnerCase["evidence"]): string | null {
  if (!evidence) return null;
  if (typeof evidence === "string") return evidence;
  const obj = evidence as Record<string, unknown>;
  const parts: string[] = [];
  const delivery = (obj.delivery ?? {}) as Record<string, unknown>;
  const photos = obj.photos ?? delivery.photos;
  if (Array.isArray(photos) && photos.length > 0) parts.push(`${photos.length} foto(s)`);
  const acta = obj.acta ?? delivery.acta;
  if (typeof acta === "string" && acta.trim()) parts.push(`acta: ${acta}`);
  const date = obj.deliveryDate ?? obj.deliveredAt ?? delivery.deliveryDate ?? delivery.deliveredAt;
  if (date) parts.push(`fecha: ${formatDate(String(date))}`);
  const responsible = obj.responsible ?? obj.deliveredBy ?? delivery.responsible ?? delivery.deliveredBy;
  if (responsible) parts.push(`responsable: ${String(responsible)}`);
  if (parts.length > 0) return parts.join(" · ");
  return JSON.stringify(evidence).slice(0, 200);
}

function lastContact(contactLog: WinnerCase["contactLog"]): { at: string; channel: string } | null {
  if (!Array.isArray(contactLog) || contactLog.length === 0) return null;
  const last = contactLog[contactLog.length - 1] as { at?: string; channel?: string };
  if (!last?.at) return null;
  return { at: last.at, channel: last.channel ?? "canal no registrado" };
}
export default async function AdminWinnersPage() {
  let cases: WinnerCase[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/winners?limit=100");
    if (!res.ok) loadError = true;
    else cases = asArray<WinnerCase>(await res.json(), "winners");
  } catch {
    loadError = true;
  }

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Ganadores</h2>
      <p className="mt-1 text-sm text-stone-600">
        Del contacto a la entrega del premio y el cierre formal de la rifa. No se publica un ganador como caso
        cerrado sin entrega registrada. Los datos personales del ganador solo se ven aquí (admin); en público solo se
        publica su número de boleto.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los casos de ganadores en este momento.
        </div>
      )}

      {!loadError && cases.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
          No hay ganadores todavía. Cuando se ejecute un sorteo, el caso aparecerá aquí para gestionarlo.
        </p>
      )}

      {cases.length > 0 && (
        <div className="mt-5 space-y-4">
          {cases.map((w) => {
            const contact = lastContact(w.contactLog);
            const evidence = evidenceSummary(w.evidence);
            return (
            <article key={w.id} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-bold text-stone-900">
                    {w.raffleTitle ?? w.raffleId} — Boleto #{w.ticketNumber ?? "—"}
                    {w.ticketCode ? <span className="font-mono text-sm text-stone-600"> ({w.ticketCode})</span> : ""}
                  </p>
                  <p className="mt-1 text-sm text-stone-600">
                    {w.buyerName ?? "Ganador sin nombre registrado"}
                    {w.buyerEmail ? ` · ${w.buyerEmail}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    Caso abierto: {formatDate(w.createdAt)}
                    {contact ? ` · Contactado: ${formatDate(contact.at)} (${contact.channel})` : ""}
                    {evidence ? ` · Evidencia: ${evidence}` : ""}
                  </p>
                  {w.notes && (
                    <p className="mt-2 whitespace-pre-line rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
                      {w.notes}
                    </p>
                  )}
                </div>
                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
                  {statusLabel(w.status)}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <WinnerCaseActions id={w.id} status={w.status} />
                <Link href={`/sorteo/${w.raffleId}`} className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                  Ver sorteo público
                </Link>
              </div>
            </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
