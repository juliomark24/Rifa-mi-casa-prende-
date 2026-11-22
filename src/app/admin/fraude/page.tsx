export const instant = false;

import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { FraudCase } from "@/components/types";
import { formatDate, statusLabel } from "@/components/format";
import { FraudCaseActions } from "@/components/AdminCaseActions";

/**
 * Prevención de fraude (plan §2.14): revisión humana de operaciones
 * marcadas. Estados: NORMAL → REVISION → RETENIDO → APROBADO / BLOQUEADO.
 * GET /api/admin/fraud-cases · PATCH /api/admin/fraud-cases/[id].
 * Nada se bloquea de forma definitiva sin revisión humana registrada.
 *
 * S9-int: la API devuelve las filas tal cual (campo `status`,
 * `reviewedBy` como objeto {name, email}); el frontend histórico leía
 * `riskStatus` y `reviewedBy` como texto, así que el estado se veía
 * vacío y las acciones recibían `undefined`. Aquí se normaliza la
 * respuesta a la forma que usa la UI.
 */
type FraudCaseRow = Omit<FraudCase, "reviewedBy"> & {
  status?: string;
  reviewedBy?: string | { name?: string; email?: string } | null;
};

function normalizeFraudCase(row: FraudCaseRow): FraudCase {
  const reviewedBy =
    typeof row.reviewedBy === "string"
      ? row.reviewedBy
      : row.reviewedBy?.name ?? row.reviewedBy?.email ?? null;
  return {
    ...row,
    riskStatus: (row.riskStatus ?? row.status ?? "REVISION") as FraudCase["riskStatus"],
    reviewedBy,
  };
}

export default async function AdminFraudPage() {
  let cases: FraudCase[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/fraud-cases?limit=100");
    if (!res.ok) loadError = true;
    else cases = asArray<FraudCaseRow>(await res.json(), "cases").map(normalizeFraudCase);
  } catch {
    loadError = true;
  }

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Fraude</h2>
      <p className="mt-1 text-sm text-stone-600">
        Operaciones marcadas por las reglas de detección (compras masivas, intentos repetidos, auto-referidos,
        reservas sin pago, retiros sospechosos). Revisión humana obligatoria antes de bloquear o retener de forma
        definitiva; todo queda en el historial de riesgo.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los casos de fraude en este momento.
        </div>
      )}

      {!loadError && cases.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">
          No hay casos de riesgo marcados. Cuando una regla dispare una marca, aparecerá aquí.
        </p>
      )}

      {cases.length > 0 && (
        <div className="mt-5 space-y-4">
          {cases.map((c) => (
            <article key={c.id} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-bold text-stone-900">
                    {c.rule ? `Regla: ${c.rule}` : `Caso ${c.id.slice(0, 8)}`}
                    {c.entityType ? ` · ${c.entityType} ${c.entityId ?? ""}` : ""}
                  </p>
                  <p className="mt-1 text-sm text-stone-600">
                    {c.reason ?? "Sin motivo registrado"}
                    {c.rule ? ` · Regla: ${c.rule}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    {c.entityType ? `${c.entityType}: ${c.entityId ?? "—"} · ` : ""}
                    Detectado: {formatDate(c.createdAt)}
                    {c.reviewedBy ? ` · Revisado por: ${c.reviewedBy}` : ""}
                    {c.decision ? ` · Decisión: ${c.decision}` : ""}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    c.riskStatus === "BLOQUEADO" || c.riskStatus === "RETENIDO"
                      ? "bg-rose-100 text-rose-800"
                      : c.riskStatus === "REVISION"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {statusLabel(c.riskStatus)}
                </span>
              </div>
              <div className="mt-4">
                <FraudCaseActions id={c.id} riskStatus={c.riskStatus} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
