"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clientApi } from "./clientApi";

type Mode = "login" | "register" | "register-afiliado";

const CONFIG: Record<Mode, { endpoint: string; title: string; subtitle: string; submit: string; redirect: string }> = {
  login: {
    endpoint: "/api/auth/login",
    title: "Iniciar sesión",
    subtitle: "Entra con tu correo y contraseña.",
    submit: "Entrar",
    redirect: "/mis-boletos",
  },
  register: {
    endpoint: "/api/auth/register",
    title: "Crear cuenta",
    subtitle: "Regístrate como cliente para comprar boletos y seguir tus órdenes.",
    submit: "Crear mi cuenta",
    redirect: "/login",
  },
  "register-afiliado": {
    endpoint: "/api/auth/register-afiliado",
    title: "Registro de afiliado",
    subtitle: "Crea tu cuenta de afiliado y gana 10% de comisión por cada boleto vendido con tu link.",
    submit: "Crear cuenta de afiliado",
    redirect: "/afiliado/panel",
  },
};

/**
 * Auth según contrato v2.2. Login con 2FA: si el usuario tiene 2FA activo,
 * POST /api/auth/login responde 202 {requires2FA:true} y el login se
 * completa con POST /api/auth/login-2fa {email, code}.
 */
export default function AuthForm({ mode }: { mode: Mode }) {
  const cfg = CONFIG[mode];
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const body: Record<string, string> = { email: email.trim(), password };
      if (mode !== "login") body.name = name.trim();
      const res = await clientApi<{ requires2FA?: boolean }>(cfg.endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.status === 202 || res.data?.requires2FA) {
        setNeeds2fa(true);
        return;
      }
      router.push(cfg.redirect);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  async function handle2fa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!code.trim()) {
      setError("Escribe el código de 6 dígitos de tu app de autenticación.");
      return;
    }
    setLoading(true);
    try {
      const res = await clientApi("/api/auth/login-2fa", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(cfg.redirect);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-black text-stone-900">{needs2fa ? "Verificación en dos pasos" : cfg.title}</h1>
        <p className="mt-1 text-sm text-stone-600">
          {needs2fa
            ? "Tu cuenta tiene 2FA activo. Escribe el código de 6 dígitos de tu app de autenticación."
            : cfg.subtitle}
        </p>

        {needs2fa ? (
          <form onSubmit={handle2fa} className="mt-5 grid gap-4">
            <label className="block text-sm font-medium text-stone-700">
              Código 2FA
              <input
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-center font-mono text-xl tracking-widest"
                placeholder="000000"
              />
            </label>
            {error && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={loading} className="rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
              {loading ? "Verificando…" : "Verificar y entrar"}
            </button>
            <button
              type="button"
              onClick={() => {
                setNeeds2fa(false);
                setCode("");
                setError(null);
              }}
              className="text-sm font-semibold text-stone-600 hover:underline"
            >
              ← Volver al inicio de sesión
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="mt-5 grid gap-4">
            {mode !== "login" && (
              <label className="block text-sm font-medium text-stone-700">
                Nombre completo
                <input required value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="Tu nombre" />
              </label>
            )}
            <label className="block text-sm font-medium text-stone-700">
              Correo electrónico
              <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="tu@correo.com" />
            </label>
            <label className="block text-sm font-medium text-stone-700">
              Contraseña
              <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="Mínimo 8 caracteres" minLength={8} />
            </label>
            {error && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={loading} className="rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
              {loading ? "Procesando…" : cfg.submit}
            </button>
          </form>
        )}

        <div className="mt-5 space-y-1 border-t border-stone-200 pt-4 text-sm text-stone-600">
          {mode === "login" && (
            <>
              <p>
                ¿No tienes cuenta? <Link href="/registro" className="font-semibold text-orange-600 hover:underline">Regístrate</Link>
              </p>
              <p>
                ¿Quieres ganar comisiones? <Link href="/registro-afiliado" className="font-semibold text-orange-600 hover:underline">Regístrate como afiliado</Link>
              </p>
            </>
          )}
          {mode === "register" && (
            <p>
              ¿Ya tienes cuenta? <Link href="/login" className="font-semibold text-orange-600 hover:underline">Inicia sesión</Link>
            </p>
          )}
          {mode === "register-afiliado" && (
            <p>
              ¿Ya eres afiliado? <Link href="/login" className="font-semibold text-orange-600 hover:underline">Inicia sesión</Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
