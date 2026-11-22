"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { SessionUser } from "./types";
import { isAdminRole } from "./types";

export default function Navbar() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setUser(data && typeof data.id === "string" ? (data as SessionUser) : null);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    router.push("/");
    router.refresh();
  }

  const linkCls = (href: string) =>
    `rounded-md px-3 py-2 text-sm font-medium ${
      pathname === href ? "bg-amber-100 text-amber-900" : "text-stone-700 hover:bg-stone-100"
    }`;

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 via-orange-600 to-rose-600 text-lg font-black text-white">
            P
          </span>
          <span className="text-lg font-black tracking-tight text-stone-900">
            PRENDE <span className="text-orange-600">RIFAS</span>
          </span>
        </Link>

        <button
          type="button"
          className="rounded-md border border-stone-300 px-3 py-2 text-sm md:hidden"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Abrir menú"
        >
          ☰
        </button>

        <nav className={`${menuOpen ? "flex" : "hidden"} absolute inset-x-0 top-full flex-col gap-1 border-b border-stone-200 bg-white px-4 py-3 md:static md:flex md:flex-row md:items-center md:gap-1 md:border-0 md:p-0`}>
          <Link href="/" className={linkCls("/")} onClick={() => setMenuOpen(false)}>
            Inicio
          </Link>
          <Link href="/verificar" className={linkCls("/verificar")} onClick={() => setMenuOpen(false)}>
            Verificar boleto
          </Link>
          <Link href="/ganadores" className={linkCls("/ganadores")} onClick={() => setMenuOpen(false)}>
            Ganadores
          </Link>
          <Link href="/soporte" className={linkCls("/soporte")} onClick={() => setMenuOpen(false)}>
            Soporte
          </Link>
          <Link href="/registro-afiliado" className={linkCls("/registro-afiliado")} onClick={() => setMenuOpen(false)}>
            Afiliados
          </Link>
          {user && (
            <Link href="/mis-boletos" className={linkCls("/mis-boletos")} onClick={() => setMenuOpen(false)}>
              Mis boletos
            </Link>
          )}
          {user?.role === "AFILIADO" && (
            <Link href="/afiliado/panel" className={linkCls("/afiliado/panel")} onClick={() => setMenuOpen(false)}>
              Panel afiliado
            </Link>
          )}
          {user && isAdminRole(user.role) && (
            <Link href="/admin" className={linkCls("/admin")} onClick={() => setMenuOpen(false)}>
              Admin
            </Link>
          )}
          {loaded && !user && (
            <Link
              href="/login"
              className="rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 md:ml-2"
              onClick={() => setMenuOpen(false)}
            >
              Iniciar sesión
            </Link>
          )}
          {loaded && user && (
            <span className="flex items-center gap-2 md:ml-2">
              <span className="max-w-40 truncate text-sm text-stone-600">{user.name}</span>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
              >
                Salir
              </button>
            </span>
          )}
        </nav>
      </div>
    </header>
  );
}
