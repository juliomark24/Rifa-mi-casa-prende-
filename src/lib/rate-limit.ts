// Rate limiting en memoria (login, registro, recuperación).
// MVP: el estado vive en el proceso y se pierde al reiniciar (documentado).
// En Fase 2, si hay varias instancias, se mueve a Redis. El límite es por
// clave (acción + email/IP) con ventana deslizante simple.
import { ApiError } from "./errors";

type Entry = { count: number; windowStart: number };

const store = new Map<string, Entry>();

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

export function checkRateLimit(key: string, opts: RateLimitOptions): void {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now - entry.windowStart >= opts.windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return;
  }
  if (entry.count >= opts.limit) {
    const retryAfterSec = Math.ceil((entry.windowStart + opts.windowMs - now) / 1000);
    throw new ApiError(
      429,
      `Demasiados intentos. Intenta de nuevo en ${retryAfterSec} segundos.`,
      "RATE_LIMITED",
    );
  }
  entry.count += 1;
}

/** Limpieza periódica (evita crecimiento sin límite del mapa). */
export function pruneRateLimitStore(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.windowStart > 60 * 60 * 1000) store.delete(key);
  }
}

/** Solo para tests: resetea el estado. */
export function resetRateLimitStore(): void {
  store.clear();
}
