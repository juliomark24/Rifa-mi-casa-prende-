export const instant = false;

import { serverFetch } from "@/components/api";
import { asArray } from "@/components/types";
import type { PaymentMethod } from "@/components/types";
import PaymentMethodCreateForm from "@/components/PaymentMethodCreateForm";
import { DeletePaymentMethodButton, TogglePaymentMethodButton } from "@/components/AdminActions";


/** GET /api/admin/payment-methods */
export default async function AdminPaymentMethodsPage() {
  let methods: PaymentMethod[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/payment-methods");
    if (!res.ok) loadError = true;
    else methods = asArray<PaymentMethod>(await res.json(), "paymentMethods");
  } catch {
    loadError = true;
  }

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Métodos de pago</h2>
      <p className="mt-1 text-sm text-stone-600">
        Un método por país y código. En Fase 1 solo MANUAL_TRANSFER es operativo; PAYPAL, AZUL_CARD y CARDNET_CARD
        responden 503 hasta la verificación real de la integración (regla 6). La configuración de cada proveedor
        (credenciales, sandbox/producción) se gestiona en{" "}
        <a href="/admin/paises#integraciones" className="font-semibold text-orange-600 hover:underline">
          Países → Integraciones de pago
        </a>
        .
      </p>

      <PaymentMethodCreateForm />

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar los métodos de pago en este momento.
        </div>
      )}

      {!loadError && methods.length === 0 && (
        <p className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600">No hay métodos de pago configurados.</p>
      )}

      {methods.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-175 text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3">País</th>
                <th className="px-4 py-3">Moneda</th>
                <th className="px-4 py-3">Código</th>
                <th className="px-4 py-3">Etiqueta</th>
                <th className="px-4 py-3">Detalles</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {methods.map((m) => (
                <tr key={m.id} className="border-t border-stone-100">
                  <td className="px-4 py-3 font-semibold">{m.country}</td>
                  <td className="px-4 py-3">{m.currency}</td>
                  <td className="px-4 py-3 font-mono text-xs">{m.code}</td>
                  <td className="px-4 py-3">{m.label}</td>
                  <td className="px-4 py-3 text-xs text-stone-500">{m.details ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${m.enabled ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>
                      {m.enabled ? "Habilitado" : "Deshabilitado"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-2">
                      <TogglePaymentMethodButton id={m.id} enabled={m.enabled} />
                      <DeletePaymentMethodButton id={m.id} label={m.label} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
