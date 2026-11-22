export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { formatMoney } from "@/components/format";


type ReportRow = Record<string, string | number | null | undefined>;

/** GET /api/admin/reports?groupBy=day|raffle|country */
export default async function AdminReportsPage({ searchParams }: { searchParams: Promise<{ groupBy?: string }> }) {
  const { groupBy } = await searchParams;
  const group = groupBy === "raffle" || groupBy === "country" ? groupBy : "day";
  let rows: ReportRow[] = [];
  let loadError = false;
  try {
    const res = await serverFetch(`/api/admin/reports?groupBy=${group}`);
    if (!res.ok) loadError = true;
    else {
      const data = await res.json();
      rows = Array.isArray(data)
        ? (data as ReportRow[])
        : ((data as { data?: ReportRow[]; reports?: ReportRow[]; rows?: ReportRow[] }).data ??
          (data as { reports?: ReportRow[] }).reports ??
          (data as { rows?: ReportRow[] }).rows ??
          []);
    }
  } catch {
    loadError = true;
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const groups: Array<[string, string]> = [
    ["day", "Por día"],
    ["raffle", "Por rifa"],
    ["country", "Por país"],
  ];

  function cellValue(v: string | number | null | undefined, key: string): string {
    if (v === null || v === undefined) return "—";
    if (typeof v === "number") {
      if (/amount|revenue|total|ingreso/i.test(key)) return formatMoney(v);
      return v.toLocaleString("es-DO");
    }
    return String(v);
  }

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Reportes</h2>
      <p className="mt-1 text-sm text-stone-600">Ventas e ingresos agrupados por día, rifa o país.</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {groups.map(([value, label]) => (
          <Link
            key={value}
            href={`/admin/reportes?groupBy=${value}`}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${group === value ? "bg-orange-600 text-white" : "bg-white text-stone-700 ring-1 ring-stone-300"}`}
          >
            {label}
          </Link>
        ))}
      </div>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar el reporte en este momento.
        </div>
      )}

      {!loadError && rows.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">No hay datos para este reporte todavía.</p>
      )}

      {rows.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-150 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="px-4 py-3">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-stone-100">
                  {columns.map((c) => (
                    <td key={c} className="px-4 py-3">{cellValue(row[c], c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
