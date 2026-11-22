export const instant = false;

import { serverFetch } from "@/components/api";
import type { SystemHealth } from "@/components/types";
import { formatDate } from "@/components/format";

/**
 * Monitoreo y continuidad (plan §2.19): salud del sistema, colas, jobs,
 * backups y alertas. GET /api/admin/health.
 * TODO (hueco del contrato): el contrato no fija los campos de la
 * respuesta de salud; la página muestra los campos conocidos y el resto
 * en "datos completos" sin inventar valores.
 */
function valueText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export default async function AdminMonitoringPage() {
  let health: SystemHealth | null = null;
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/health");
    if (!res.ok) loadError = true;
    else health = (await res.json()) as SystemHealth;
  } catch {
    loadError = true;
  }

  const status = typeof health?.status === "string" ? health.status : null;
  const ok = status === "ok" || status === "OK" || status === "healthy" || status === "HEALTHY";
  const jobs = Array.isArray(health?.jobs) ? health.jobs : [];
  const alerts = Array.isArray(health?.alerts) ? health.alerts : [];

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Monitoreo</h2>
      <p className="mt-1 text-sm text-stone-600">
        Salud del sistema: disponibilidad, colas, jobs, backups y alertas. El software detecta que algo está mal
        antes de que el cliente se queje.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos consultar la salud del sistema en este momento.
        </div>
      )}

      {!loadError && health && (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Estado general</p>
              <p className={`mt-1 text-2xl font-black ${ok ? "text-emerald-700" : "text-amber-700"}`}>
                {status ?? "Sin estado"}
              </p>
              {health.checkedAt && <p className="mt-1 text-xs text-stone-500">Revisado: {formatDate(health.checkedAt)}</p>}
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Base de datos</p>
              <p className="mt-1 text-lg font-bold text-stone-900">{valueText(health.database)}</p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Colas</p>
              <p className="mt-1 text-lg font-bold text-stone-900">{valueText(health.queues)}</p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Último backup</p>
              <p className="mt-1 text-lg font-bold text-stone-900">
                {health.lastBackupAt ? formatDate(health.lastBackupAt) : valueText(health.backups)}
              </p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Jobs registrados</p>
              <p className="mt-1 text-2xl font-black text-stone-900">{jobs.length}</p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Alertas activas</p>
              <p className={`mt-1 text-2xl font-black ${alerts.length > 0 ? "text-rose-700" : "text-stone-900"}`}>{alerts.length}</p>
            </div>
          </div>

          {alerts.length > 0 && (
            <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-5" role="alert">
              <h3 className="font-bold text-rose-900">Alertas</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-800">
                {alerts.map((a, i) => (
                  <li key={i}>{typeof a === "string" ? a : JSON.stringify(a)}</li>
                ))}
              </ul>
            </div>
          )}

          <section className="mt-8">
            <h3 className="text-lg font-bold text-stone-900">Jobs (ejecuciones registradas)</h3>
            <p className="mt-1 text-sm text-stone-600">
              Cada job registra inicio, fin, resultado, errores y reintentos, y es re-ejecutable sin duplicar
              efectos.
            </p>
            {jobs.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">No hay ejecuciones de jobs registradas.</p>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
                <table className="w-full min-w-150 text-left text-sm">
                  <thead className="bg-stone-50 text-xs uppercase text-stone-500">
                    <tr>
                      <th className="px-4 py-3">Job</th>
                      <th className="px-4 py-3">Estado</th>
                      <th className="px-4 py-3">Inicio</th>
                      <th className="px-4 py-3">Fin</th>
                      <th className="px-4 py-3">Resultado / error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j, i) => (
                      <tr key={j.id ?? i} className="border-t border-stone-100">
                        <td className="px-4 py-3 font-mono text-xs font-bold">{j.name}</td>
                        <td className="px-4 py-3">{j.status ?? "—"}</td>
                        <td className="px-4 py-3">{formatDate(j.startedAt)}</td>
                        <td className="px-4 py-3">{formatDate(j.finishedAt)}</td>
                        <td className="px-4 py-3 text-xs">{j.error ?? j.result ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <details className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 text-sm shadow-sm">
            <summary className="cursor-pointer font-semibold text-stone-800">Ver datos completos de salud</summary>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-stone-50 p-3 font-mono text-xs text-stone-700">
              {JSON.stringify(health, null, 2)}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}
