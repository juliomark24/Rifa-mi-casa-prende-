"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: Array<[string, string]> = [
  ["/admin", "Dashboard"],
  ["/admin/rifas", "Rifas"],
  ["/admin/ventas", "Ventas"],
  ["/admin/boletos", "Boletos"],
  ["/admin/afiliados", "Afiliados"],
  ["/admin/retiros", "Retiros"],
  ["/admin/sorteos", "Sorteos"],
  ["/admin/ganadores", "Ganadores"],
  ["/admin/paises", "Países e integraciones"],
  ["/admin/metodos-pago", "Métodos de pago"],
  ["/admin/conciliacion", "Conciliación"],
  ["/admin/ledger", "Ledger"],
  ["/admin/soporte", "Soporte"],
  ["/admin/fraude", "Fraude"],
  ["/admin/notificaciones", "Notificaciones"],
  ["/admin/monitoreo", "Monitoreo"],
  ["/admin/reportes", "Reportes"],
  ["/admin/config", "Configuración"],
];

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-2 overflow-x-auto pb-2 md:flex-col md:overflow-visible md:pb-0" aria-label="Menú de administración">
      {LINKS.map(([href, label]) => {
        const active = href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${
              active ? "bg-orange-600 text-white" : "bg-white text-stone-700 hover:bg-stone-100"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
