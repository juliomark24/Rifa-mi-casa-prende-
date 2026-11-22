// Idempotencia de operaciones críticas (plan §2.12): repetir la misma
// operación (misma clave + scope) devuelve la misma respuesta sin efectos
// duplicados. La respuesta queda guardada en IdempotencyKey.
import { db } from "./db";

export type IdempotentFn<T> = () => Promise<T>;

/**
 * Ejecuta `fn` una sola vez por (scope, key). Si la clave ya existe,
 * devuelve la respuesta guardada sin volver a ejecutar `fn`.
 * La respuesta debe ser serializable a JSON.
 */
export async function withIdempotency<T>(scope: string, key: string, fn: IdempotentFn<T>): Promise<T> {
  const existing = await db.idempotencyKey.findUnique({
    where: { key_scope: { key, scope } },
  });
  if (existing?.response !== null && existing?.response !== undefined) {
    return existing.response as T;
  }
  const result = await fn();
  try {
    await db.idempotencyKey.upsert({
      where: { key_scope: { key, scope } },
      update: { response: result as object },
      create: {
        key,
        scope,
        response: result as object,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  } catch {
    // Carrera: otro proceso guardó la clave primero; la respuesta guardada
    // es la válida. Se devuelve el resultado ya calculado (idéntico).
  }
  return result;
}
