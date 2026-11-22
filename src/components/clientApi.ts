// Llamadas a la API desde el navegador (componentes "use client").
// La sesión viaja en la cookie httpOnly `pr_session` (same-origin); el
// cliente nunca maneja el token. Errores de la API: { "error": "mensaje" }.
import { apiErrorMessage } from "./types";

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string };

/**
 * Llamada a la API desde el navegador. Incluye las cookies de sesión
 * (same-origin) y, si se pasa, la clave de idempotencia del intento.
 * Nunca lanza: los fallos de red se devuelven como {ok:false, status:0}.
 */
export async function clientApi<T>(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<ApiResult<T>> {
  const { idempotencyKey, ...fetchInit } = init ?? {};
  try {
    const res = await fetch(path, {
      ...fetchInit,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(fetchInit.headers ?? {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
    });
    const data = (await res.json().catch(() => null)) as T | null;
    if (!res.ok) {
      return { ok: false, status: res.status, error: apiErrorMessage(data, `Error ${res.status}: no se pudo completar la operación.`) };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch {
    return { ok: false, status: 0, error: "No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo." };
  }
}
