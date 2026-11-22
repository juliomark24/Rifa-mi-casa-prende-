export const instant = false;

import { serverFetch } from "@/components/api";
import SettingsForm from "@/components/SettingsForm";


interface Setting {
  key: string;
  value: string;
}

/** GET /api/admin/settings */
export default async function AdminConfigPage() {
  let settings: Setting[] = [];
  let loadError = false;
  try {
    const res = await serverFetch("/api/admin/settings");
    if (!res.ok) loadError = true;
    else {
      const data = await res.json();
      if (Array.isArray(data)) settings = data as Setting[];
      else if (data && typeof data === "object") {
        const obj = data as Record<string, unknown>;
        if (Array.isArray(obj.settings)) settings = obj.settings as Setting[];
        else {
          // Forma objeto {CLAVE: valor}
          settings = Object.entries(obj).map(([key, value]) => ({ key, value: String(value ?? "") }));
        }
      }
    }
  } catch {
    loadError = true;
  }

  return (
    <div>
      <h2 className="text-2xl font-black text-stone-900">Configuración</h2>
      <p className="mt-1 text-sm text-stone-600">Textos legales y parámetros del sistema, como la tasa de comisión de afiliados.</p>

      {loadError && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          No pudimos cargar la configuración en este momento.
        </div>
      )}

      <div className="mt-5">
        <SettingsForm initial={settings} />
      </div>
    </div>
  );
}
