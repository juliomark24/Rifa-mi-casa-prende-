export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { SupportTicket } from "@/components/types";
import { formatDate, statusLabel, supportTypeLabel } from "@/components/format";
import { SupportTicketActions } from "@/components/AdminCaseActions";

/**
 * Soporte y reclamaciones (plan §2.17): tickets con número de caso único,
 * estado, historial, responsable y prioridad. GET /api/admin/support-tickets
 * · PATCH /api/admin/support-tickets/[id].
 */
export default async function AdminSupportPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const filter = status ?? "";
  let tickets: SupportTicket[] = [];
  let loadError = false;
  try {
    const qs = filter ? `?status=${encodeURIComponent(filter)}` : "";
    const res = await serverFetch(`/api/admin/support-tickets${qs}`);
    if (!res.ok) loadError = true;
    else tickets = asArray<SupportTicket>(await res.json(), "tickets");
  } catch {
    loadError = true;
  }

  const filters: Array<[string, string]> = [
    ["", "Todos"],
    ["ABIERTO", "Abiertos"],
    ["EN_REVISION", "En revisión"],
    ["ESPERANDO_CLIENTE", "Esperando al cliente"],
    ["RESUELTO", "Resueltos"],
    ["CERRADO", "Cerrados"],
  ];
  const openCount = tickets.filter((t) => t.status === "ABIERTO" || t.status === "EN_REVISION").length;

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Soporte</h2>
      <p className="mt-1 text-sm text-stone-600">
        Tickets y reclamaciones. Una reclamación de “pagué sin boleto” enlaza con el caso de recuperación o
        conciliación correspondiente. {tickets.length > 0 && `${openCount} ticket(s) pendientes de resolver.`}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {filters.map(([value, label]) => (
          <Link
            key={value}
            href={value ? `/admin/soporte?status=${value}` : "/admin/soporte"}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${filter === value ? "bg-orange-600 text-white" : "bg-white text-stone-700 ring-1 ring-stone-300"}`}
          >
            {label}
          </Link>
        ))}
      </div>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los tickets en este momento.
        </div>
      )}

      {!loadError && tickets.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">No hay tickets con este filtro.</p>
      )}

      {tickets.length > 0 && (
        <div className="mt-5 space-y-4">
          {tickets.map((t) => (
            <article key={t.id} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-bold text-stone-900">
                    {t.number ?? t.caseNumber ? (
                      <span className="font-mono text-sm">{t.number ?? t.caseNumber}</span>
                    ) : (
                      `#${t.id.slice(0, 8)}`
                    )}{" "}
                    — {t.subject ?? supportTypeLabel(t.type)}
                  </p>
                  <p className="mt-1 text-sm text-stone-600">
                    {supportTypeLabel(t.type)}
                    {t.order?.code ? ` · Orden ${t.order.code} (${t.order.status})` : t.orderCode ? ` · Orden ${t.orderCode}` : ""}
                    {t.buyerName ? ` · ${t.buyerName}` : ""}
                    {t.buyerEmail ? ` (${t.buyerEmail})` : ""}
                  </p>
                  {t.description && <p className="mt-2 whitespace-pre-line text-sm text-stone-700">{t.description}</p>}
                  <p className="mt-2 text-xs text-stone-500">
                    Creado: {formatDate(t.createdAt)}
                    {t.owner ? ` · Responsable: ${t.owner.name} (${t.owner.email})` : " · Sin responsable asignado"}
                    {t.priority ? ` · Prioridad: ${t.priority}` : ""}
                    {t.dueAt ? ` · Vence: ${formatDate(t.dueAt)}` : ""}
                  </p>
                </div>
                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
                  {statusLabel(t.status)}
                </span>
              </div>
              <div className="mt-4">
                <SupportTicketActions id={t.id} status={t.status} currentAssignee={t.owner?.name ?? t.ownerId} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
