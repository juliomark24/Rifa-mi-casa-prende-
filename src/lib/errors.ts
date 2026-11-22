// Errores de API uniformes (contrato API-CONTRACT-v2.2.md).
// Formato: { "error": "mensaje" } + código HTTP.
import { NextResponse } from "next/server";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string, code = "VALIDATION_ERROR") {
  return new ApiError(400, message, code);
}
export function unauthorized(message = "No autenticado", code = "UNAUTHORIZED") {
  return new ApiError(401, message, code);
}
export function forbidden(message = "Sin permiso", code = "FORBIDDEN") {
  return new ApiError(403, message, code);
}
export function notFound(message = "No existe", code = "NOT_FOUND") {
  return new ApiError(404, message, code);
}
export function conflict(message: string, code = "CONFLICT") {
  return new ApiError(409, message, code);
}
export function notConfigured(message: string) {
  return new ApiError(503, message, "NOT_CONFIGURED");
}

/** Convierte cualquier error lanzado en un handler a respuesta JSON. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("[api]", err);
  return NextResponse.json(
    { error: "Error interno del servidor", code: "INTERNAL_ERROR" },
    { status: 500 },
  );
}

/** Envuelve un handler de ruta para convertir errores en respuestas JSON. */
export function withErrorHandling<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>,
) {
  return async (...args: T): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
