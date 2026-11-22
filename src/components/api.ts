// Helpers de fetch del lado del servidor (Server Components / layouts).
// Reenvían las cookies de la petición para que /api/auth/me y las rutas
// protegidas vean la sesión (cookie httpOnly pr_session).
// SOLO servidor: no importar este módulo desde componentes "use client"
// (usa @/components/clientApi para el navegador).
import { cookies } from "next/headers";
import type { SessionUser } from "./types";

export function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");
  return fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    cache: "no-store",
  });
}

/** Normaliza GET /api/auth/me: acepta el usuario directo o envuelto en {user}. */
export function normalizeSession(data: unknown): SessionUser | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const candidate = (obj.user && typeof obj.user === "object" ? obj.user : obj) as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") return null;
  return {
    id: candidate.id,
    name: typeof candidate.name === "string" ? candidate.name : candidate.email,
    email: candidate.email,
    role: candidate.role as SessionUser["role"],
    referralCode: typeof candidate.referralCode === "string" ? candidate.referralCode : null,
  };
}

/** Sesión actual según GET /api/auth/me, o null si no hay sesión. */
export async function getSession(): Promise<SessionUser | null> {
  try {
    const res = await serverFetch("/api/auth/me");
    if (!res.ok) return null;
    return normalizeSession(await res.json().catch(() => null));
  } catch {
    return null;
  }
}
