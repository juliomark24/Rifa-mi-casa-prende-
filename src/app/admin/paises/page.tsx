export const instant = false;

import Link from "next/link";
import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { Country, PaymentMethod } from "@/components/types";
import { countryClassLabel, statusLabel } from "@/components/format";
import CountryForm from "@/components/CountryForm";
import PaymentIntegrations from "@/components/PaymentIntegrations";
import { CountryActivateButton } from "@/components/AdminCaseActions";

/**
 * Configuración Internacional (plan §2.9): CRUD de países ("Agregar país",
 * 16 campos, estados BORRADOR/CONFIGURACION/REVISION/ACTIVO, clasificación
 * A/B/C) + sección "Integraciones de pago" (aclaración del dueño 21 nov
 * 2026, 17:39 AST): proveedores preintegrados gestionados desde el panel.
 * GET /api/admin/countries · GET /api/admin/payment-methods.
 */
export default async function AdminCountriesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  let countries: Country[] = [];
  let methods: PaymentMethod[] = [];
  let loadError = false;
  try {
    const [cRes, mRes] = await Promise.all([
      serverFetch("/api/admin/countries?limit=100"),
      serverFetch("/api/admin/payment-methods?limit=100"),
    ]);
    if (!cRes.ok) loadError = true;
    else countries = asArray<Country>(await cRes.json(), "countries");
    if (mRes.ok) methods = asArray<PaymentMethod>(await mRes.json(), "paymentMethods");
  } catch {
    loadError = true;
  }

  const editing = edit ? countries.find((c) => c.id === edit) ?? null : null;

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Configuración Internacional — Países</h2>
      <p className="mt-1 text-sm text-stone-600">
        Cada rifa pertenece a un país. Solo un país ACTIVO puede vender boletos; activar exige pasar el gate legal y
        de proveedor. Lanzamiento solo en República Dominicana; Colombia pendiente de revisión; demás países
        bloqueados por defecto.
      </p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los países en este momento.
        </div>
      )}

      {!loadError && countries.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-175 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3">País</th>
                <th className="px-4 py-3">Moneda</th>
                <th className="px-4 py-3">Zona horaria</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Clasificación</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {countries.map((c) => (
                <tr key={c.id} className="border-t border-stone-100">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-stone-900">
                      {c.flag ? `${c.flag} ` : ""}
                      {c.name}
                    </p>
                    <p className="font-mono text-xs text-stone-500">{c.code}</p>
                  </td>
                  <td className="px-4 py-3">
                    {c.currencyCode ?? c.currency} {c.currencySymbol ? `(${c.currencySymbol})` : ""}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{c.timezone}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${c.status === "ACTIVO" ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>
                      {statusLabel(c.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">{countryClassLabel(c.classification)}</td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-2">
                      <Link href={`/admin/paises?edit=${c.id}`} className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                        Editar
                      </Link>
                      <CountryActivateButton id={c.id} status={c.status} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="mt-8">
        <h3 className="text-lg font-bold text-stone-900">{editing ? `Editar país: ${editing.name}` : "Agregar país"}</h3>
        {editing && (
          <p className="mt-1 text-sm text-stone-600">
            <Link href="/admin/paises" className="font-semibold text-orange-600 hover:underline">
              ← Cancelar edición
            </Link>
          </p>
        )}
        <div className="mt-4">
          <CountryForm country={editing ?? undefined} />
        </div>
      </section>

      <PaymentIntegrations methods={methods} countries={countries} />
    </div>
  );
}
