<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# PRENDE RIFAS — reglas de trabajo (plan v2.2, especificación congelada)

Documento maestro: `../plan-tecnico-v2.md` (v2.2, aprobado 21 nov 2026).
Ejecución: `../EJECUCION-v2.2.md`. Contrato API: `API-CONTRACT-v2.2.md`.
El bloque Next.js de arriba lo regenera `next dev`; no se borra.

## File ownership (para no pisarse entre agentes)

- **Backend (A):** `prisma/`, `src/lib/`, `src/app/api/`, `tests/`, `package.json` (dependencias), `.env.example`.
- **Frontend (B):** `src/app/**` EXCEPTO `src/app/api/**`, `src/components/**`. NO toca `package.json`, `prisma/`, `src/lib/`.
- **Docs/Infra (C):** `README.md`, `AGENTS.md` (este archivo), `.gitignore`, `EJECUCION-v2.2.md`, `API-CONTRACT-v2.2.md`, `docs/`, git init + pushes.
- **Nadie toca:** `levantamiento-rifamicasa-2026-11-21.md`, `plan-tecnico-v2.md`, `SPEC.md` (histórico v1; el plan v2.2 manda).

## Reglas de código (no negociables)

- TypeScript estricto; **zod en TODOS los endpoints**; el rol **NUNCA** viene del cliente (viene de la sesión JWT).
- **Secretos solo por variables de entorno.** `.env` y `*.db` NUNCA se commitean (ver `.gitignore`). No hay secretos hardcodeados (lección de la auditoría del repo viejo).
- JWT con `jose`, cookie httpOnly `pr_session`; sin fallback débil de `JWT_SECRET` en producción.
- **Dinero en enteros** (unidades mayores de la moneda). Nunca floats para dinero.
- Toda operación crítica con clave de idempotencia; toda escritura de dinero pasa por transacción Prisma.
- **Stripe NO es proveedor para RD** (plan §2.2). No construir el camino crítico sobre Stripe. PayPal y Azul/CardNet quedan como skeleton NO operativo hasta verificación real (regla 6).
- SQLite solo para desarrollo local; el esquema debe ser compatible con PostgreSQL (sin funciones específicas de SQLite).

## Reglas de ejecución (las 10 aclaraciones del dueño, 21 nov 2026)

1. Sorteo verificable: pruebas independientes de reproducibilidad, serialización determinista de la lista elegible, semillas CSPRNG, publicación verificable del compromiso previo.
2. "Ganador publicado" INDEPENDIENTE de "premio entregado / caso cerrado".
3. Jobs resistentes a reinicios, duplicados, interrupciones y fallos parciales (idempotencia, reintentos, registros, recuperación). Ver `docs/jobs.md`.
4. Fase 1 en subfases técnicas internas, con validación y aprobación antes de avanzar (sin cambiar el alcance).
5. Recuperación de cuentas admin y 2FA: diseñado, documentado y probado; sin atajos que salten controles. Ver `docs/recuperacion-admin-2fa.md`.
6. Ninguna pasarela es operativa hasta verificar integración real + autorización para rifas + conciliación.
7. Ningún módulo se declara terminado por su interfaz visual: funcionamiento real, pruebas, errores, recuperación, evidencia, documentación.
8. Cambio de arquitectura obligado por un problema técnico: DETENERSE, explicar, presentar alternativa, ESPERAR aprobación.
9. Cada fase entrega 7 cosas: código, pruebas ejecutadas, resultados, errores encontrados y corregidos, riesgos pendientes, evidencia de funcionamiento, confirmación de no regresión.
10. Producto de producción con dinero real. No demo, no simulación, no apariencia sin funcionalidad.

## Aclaración del dueño (21 nov 2026, 17:39 AST)

Las integraciones de los métodos de pago se gestionan **desde el panel de control admin** (sección Configuración Internacional) para no detener la operación. Proveedores preintegrados desde el inicio: Azul, CardNet, PayPal y transferencia manual (Mercado Pago en Fase 2). Una pasarela completamente nueva sigue necesitando su adaptador desarrollado una vez (distinción A/B/C sin cambios). Ninguna pasarela es operativa hasta verificación real (regla 6). Ver nota en `EJECUCION-v2.2.md`, subfase S5.

## Antes de commitear

- `git status`: verifica que `.env`, `*.db`, `node_modules/` y `.next/` NO aparecen.
- No commitear secretos, credenciales ni valores reales de `.env.example`.
- Cada subfase termina con reporte al coordinador con los 7 entregables de la regla 9; el coordinador verifica antes de autorizar la siguiente subfase.
