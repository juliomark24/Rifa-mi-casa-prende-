# INFORME DE FASE 1 — PRENDE RIFAS (Plan Técnico v2.2)

**Fecha:** 21 de noviembre de 2026 (cierre S10, validación final)
**Documento maestro:** `../plan-tecnico-v2.md` v2.2 (especificación congelada, aprobada por el dueño 21 nov 2026 17:36 AST)
**Ejecución:** `../EJECUCION-v2.2.md` (reglas 1–10 del dueño)
**Contrato API:** `API-CONTRACT-v2.2.md`
**Repositorio:** `prende-rifas/` (Next.js 16 + Prisma + SQLite dev; PostgreSQL en producción), rama `main`
**Commits de Fase 1:** `e1f91e5`, `a0f8155`, `f0aeec4`, `f55cead`, `ee076a5` (el trabajo de S10 queda sin commitear para el coordinador, como ordena la tarea)

Este informe es el cierre de la Fase 1 con los 7 entregables de la regla 9: (1) código implementado, (2) pruebas ejecutadas, (3) resultados, (4) errores encontrados y corregidos, (5) riesgos pendientes, (6) evidencia de funcionamiento, (7) confirmación de no regresión.

**Veredicto de S10: la Fase 1 está COMPLETA en código y pruebas (28/28 P superadas en test, suite 247/247), pero el LANZAMIENTO A PRODUCCIÓN SIGUE BLOQUEADO** por 6 de los 18 ítems del checklist, todos dependientes del dueño, de lo legal o de credenciales reales de pasarela. Ningún ítem bloqueado se marca como pasado. Ver §3.2.

---

## 1. Código implementado (resumen por subfase)

Stack: Next.js 16 (App Router, TypeScript estricto), Prisma (schema v2, 33 tablas, 843 líneas), SQLite en desarrollo / PostgreSQL en producción, JWT con `jose` + cookie httpOnly, bcryptjs (12 rounds), TOTP 2FA, zod en todos los endpoints. Dinero en enteros, nunca floats. Totales al cierre: **218 archivos en `src/`**, **82 rutas API**, **32 páginas**, **40 archivos en `src/lib/` + `src/lib/payments/` + `src/jobs/`**.

| Subfase | Qué se construyó | Estado |
|---|---|---|
| S0-infra | Fundación: repo git en `main`, `.gitignore` (`.env`, `*.db` nunca se commitean), `.env.example` sin valores reales, README, AGENTS.md, `docs/recuperacion-admin-2fa.md`, `docs/jobs.md`, `docs/repo-github.md`, contrato API v2.2, lista Fase 0 para el dueño | ACEPTADA |
| S1 | Datos v2: schema Prisma completo v2.2 (33 tablas) + migraciones + seed idempotente (DO ACTIVO clase A, 4 proveedores, rifa demo BORRADOR, afiliado demo) | ACEPTADA |
| S2 | Seguridad: auth JWT + sesiones revocables en BD, RBAC de 7 roles con matriz de permisos por función, 2FA TOTP obligatorio para admins + códigos de respaldo, recuperación de cuenta admin/2FA sin atajos (aprobación de otro superadmin con 2FA) | ACEPTADA |
| S3 | Rifas + países + bases: máquina de 11 estados, "Agregar país" (16 campos, clasificación A/B/C), Configuración Internacional, gate de activación (legal + proveedor), versionado de bases (v1, v2… inmutables), control de cambios (ChangeLog + AuditLog, doble aprobación pragmática con `approvedById`) | ACEPTADA |
| S4 | Pedidos + boletos + reservas: reserva ~10 min con expiración, unicidad transaccional `(rifa, número)` + 409 con sugerencia de cercanos, idempotencia de pedido y reserva, pedidos de 6 estados, afiliación (ventana 7 días, último clic, auto-referido bloqueado), TermsAcceptance en la compra, anulación con motivo, job liberador de reservas resiliente | ACEPTADA |
| S5 | Pagos: interfaz `PaymentProvider` + registro de 4 adaptadores preintegrados (solo transferencia manual OPERATIVA; PayPal, Azul y CardNet skeleton NO operativo, 503 `NOT_CONFIGURED`, regla 6), webhooks con firma verificada (Azul/CardNet HMAC-SHA256 tiempo constante; PayPal vía API oficial), tabla de eventos de webhook con idempotencia, `operations.ts` como único camino para mover dinero (confirm/refund/fail), conciliación (`reconcile-provider`), expiración de pendientes manuales (aviso 20 h, expiración 24 h), comprobante PDF binario real con QR (pdfkit) | ACEPTADA |
| S6 | Ledger + afiliados + fraude: ledger append-only con saldos derivados por moneda, comisiones 10% solo sobre pagos confirmados + retención (PENDING → RETAINED → AVAILABLE) + ajuste por reembolso/contracargo (incl. saldo negativo absorbible), retiros (mínimo RD$500, aprobación, doble aprobación > RD$10.000), módulo de fraude (velocidad, auto-referido, duplicados, reembolsos, contracargo; revisión humana obligatoria), reportes de ledger + CSV, rutas de conciliación y ledger | ACEPTADA |
| S7 | Sorteo: commit-reveal completo (congelamiento de elegibles con serialización determinista, commitment SHA256 publicado antes, semilla CSPRNG de 32 bytes revelada después, ganador determinista SHA256-CHAIN-v1, verificación independiente con `scripts/verify-draw.mjs` solo `node:crypto`), bloqueo de sorteo con pendientes/reservas y de segundo sorteo, gestión del ganador en 7 estados (publicado ≠ entregado, regla 2), cierre solo con evidencia de entrega, procedimientos de no elegible / renuncia / sin respuesta / imposibilidad | ACEPTADA |
| S8 | Notificaciones + soporte + monitoreo: motor de notificaciones (9 eventos + alerta_sistema, cola con backoff 1/5/15/60/240 min, dedupe, regla de oro: nunca rompe la compra), tickets de soporte (máquina de estados, reapertura, contexto pedido/pagos/boletos), 10 alertas de monitoreo (§2.19), health endpoint, jobs resilientes (runner con JobRun, anti-solape, recuperación de huérfanas), backup diario con verificación SHA256 + `scripts/restore-test.mjs` | ACEPTADA |
| S9-integración | Frontend conectado al backend real end-to-end (viaje completo del dinero verificado en test), checkout dinámico por país, rutas nuevas del contrato (`GET /api/payment-methods`, admin payment-methods, `/stats`, `/reports`, `/settings`), páginas admin de conciliación y ledger, 4 correcciones de S6 (bloqueo de compras por fraude, `retention-sweep` salta comisiones con caso abierto, falso positivo de conciliación, parte financiera del contracargo), ventas rechazadas en rifas no ACTIVAS | ACEPTADA |
| **S10 (esta subfase)** | Validación final: mapa P1–P28 con evidencia, checklist de 18 ítems, 8 tests nuevos en `tests/s10-p1-p28.test.ts` (huecos P3, P9, P12, P17, P27), corrección P27 en `src/app/api/admin/reports/route.ts` (la agrupación ya no mezcla monedas), verificación del seed real + `GET /api/payment-methods?country=DO`, build + smoke HTTP final, este informe | — (para el coordinador) |

### 1.1 Código de S10 (detalle)

- **`tests/s10-p1-p28.test.ts`** (nuevo, 8 tests): P3 (webhook de denegación → pedido/pago FALLIDO, boletos liberados y desvinculados, sin comisión ni VENTA; número reutilizable; `failOrderPayment` idempotente), P9 (desconexión + reconexión de Prisma como reinicio simulado: compra, boletos y saldos intactos), P12 (anular sin motivo → 400; anular con motivo → ANULADO + `refundRequired`, sin cambiar número ni comprador; segundo intento → 409; boleto VENDIDO no se puede bloquear; block/unblock no cambian el número), P17 (adaptador nuevo implementa la interfaz completa y pasa sandbox sin tocar el núcleo; el registro solo expone los 4 preintegrados), P27 (snapshot de moneda/valor en pedido, pago y ledger; saldos por moneda; reporte global con una fila por moneda).
- **`src/app/api/admin/reports/route.ts`** (corrección, no funcionalidad nueva): la clave de agrupación del reporte ahora incluye la moneda (`fecha||moneda`); el campo `group` visible sigue siendo la fecha/rifa/país. Antes, un reporte global sumaba pedidos DOP y USD en una misma fila etiquetada con la moneda del primer pedido.
- **Seed (sin cambios, verificado):** la nota de S9 decía que `prisma/seed.ts` crea los 4 proveedores pero ningún `PaymentMethod` ni `CountryPaymentConfig`. **La nota era incorrecta**: el seed crea los 4 métodos y las 4 configuraciones DO desde el primer commit (`e1f91e5`). S10 lo verificó ejecutando el seed real dos veces (idempotente) sobre una BD fresca y llamando a `GET /api/payment-methods?country=DO` → 200 con solo `MANUAL_TRANSFER` (Transferencia bancaria, DOP). No se sembraron Azul/CardNet/PayPal como operativos (regla 6).
- **Sin cambios de schema Prisma.** No se tocó `src/lib/jobs.ts`, `src/lib/draw.ts`, ni tests de otras subfases.

---

## 2. Pruebas ejecutadas

Todas en BD aislada (`DATABASE_URL="file:./test-s10.db"`, `prisma db push` antes de vitest; nunca `prisma/test.db`). Comandos:

```bash
export DATABASE_URL="file:./test-s10.db"
rm -f prisma/test-s10.db && npx prisma db push --accept-data-loss
npx vitest run tests/s10-p1-p28.test.ts   # 8/8
npx vitest run                            # suite completa: 247/247, 18 archivos, ~6,5 min
npx tsc --noEmit                          # 0 errores
npm run build                             # exit 0
```

Verificación del seed (BD aparte `test-s10-seed.db`):

```bash
export DATABASE_URL="file:./test-s10-seed.db" SEED_ADMIN_PASSWORD="SeedCheck123!"
npx prisma db push --accept-data-loss && npx tsx prisma/seed.ts   # ×2, idempotente
# GET /api/payment-methods?country=DO → 200, data: [MANUAL_TRANSFER / Transferencia bancaria / DOP]
# GET /api/payment-methods?country=XX → 200, data: []
# Conteo: 4 providers, 4 methods, 4 configs DO
```

Smoke HTTP final (servidor de producción `npm start`, puerto 3000, `curl -L`): **13/13 rutas 200** — `/`, `/rifas/1`, `/ganadores`, `/verificar`, `/soporte`, `/login`, `/registro`, `/api/raffles`, `/api/winners`, `/api/payment-methods?country=DO`, `/admin`, `/admin/paises`, `/admin/monitoreo`. (Las rutas admin redirigen a `/login` sin sesión; el 200 es tras seguir la redirección, como en S9.)

---

## 3. Resultados

### 3.1 Tabla P1–P28 (plan §5.1)

| # | Prueba | Test real (archivo + nombre) | Resultado |
|---|---|---|---|
| P1 | 100 compran el mismo número a la vez | `tests/s4-orders-tickets.test.ts` — "P1: 100 compradores concurrentes por el mismo número → solo uno lo obtiene" | **PASA** (SQLite; ver riesgo P1-Postgres) |
| P2 | Pago aprobado = boleto exactamente una vez | `tests/s5-payments.test.ts` — "confirmación manual end-to-end: pedido + pago + boletos + VENTA + comisión 10% + notificación" (2 VENDIDO, exactamente 1 asiento VENTA, 1 comisión) + "P3: confirmar dos veces… no duplica asientos ni boletos" | **PASA** |
| P3 | Pago rechazado = sin boleto | **S10** `tests/s10-p1-p28.test.ts` — "webhook de denegación → pedido FALLIDO…" + "el número liberado… se puede volver a comprar" + "failOrderPayment es idempotente…" (hueco: la función existía, ningún test la ejercía) | **PASA** |
| P4 | Webhook duplicado = sin duplicado | `tests/s5-payments.test.ts` — "P4: webhook duplicado (MockProvider) → un solo efecto" | **PASA** |
| P5 | Abandono de checkout = reserva liberada | `tests/s4-orders-tickets.test.ts` — "P5: reserva vencida → número liberado + registro; re-ejecutar no duplica" | **PASA** |
| P6 | Reembolso = comisión ajustada | `tests/s5-payments.test.ts` — "P4/P6: reembolso con asiento compensatorio + comisión ajustada + boletos liberados"; `tests/s6-ledger-affiliates-fraud.test.ts` — bloque "P6 — comisiones…" (8 tests: PENDING/AVAILABLE/PAID, idempotencia) | **PASA** |
| P7 | Sorteo sin condiciones = bloqueado | `tests/s7-draw-winner.test.ts` — "P7: commit bloqueado con pedido pendiente o reserva activa" + "P7: execute bloqueado si aparece un pendiente tras el commit" | **PASA** |
| P8 | Segundo sorteo = bloqueado | `tests/s7-draw-winner.test.ts` — "P8: segundo commit y segundo execute → 409" | **PASA** |
| P9 | Reinicio del servidor = sin pérdida | **S10** `tests/s10-p1-p28.test.ts` — "tras desconectar y reconectar Prisma (reinicio simulado), la compra confirmada, los boletos y los saldos siguen intactos" (hueco: sin test antes) | **PASA** (reinicio simulado a nivel de conexión; ver riesgo) |
| P10 | Backup restaurado = datos correctos | `tests/s8-notifications-support.test.ts` — "P10 — backup restaurado = datos correctos" (backup + `scripts/restore-test.mjs` verifican ventas, boletos, comisiones y saldos) | **PASA** |
| P11 | Acceso a panel ajeno = denegado | `tests/rbac.test.ts` — matriz (5 tests: cliente/afiliado sin permisos admin, auditor solo lectura, admin de rifas sin retiros/finanzas, finanzas sin crear rifas, superadmin todo) + "RBAC en endpoints admin" (403/401) | **PASA** |
| P12 | Cambio de boleto vendido = bloqueado o anulación controlada | **S10** `tests/s10-p1-p28.test.ts` — "anular sin motivo → 400; anular con motivo → ANULADO + refundRequired…" + "bloquear/desbloquear no cambia el número…; un boleto VENDIDO ni siquiera se puede bloquear" (hueco: la anulación existía, sin test directo de inmutabilidad) | **PASA** |
| P13 | Cambio de precio/total/premio/fecha con ventas = bloqueado o con registro + aviso | `tests/s3-raffles-countries.test.ts` — bloque "S3 — cambios sensibles y control de cambios (§2.7, §2.20, P28)" (7 tests: precio/premio/total sin aprobación → 409, con segundo superadmin → 200 + ChangeLog + aviso, fecha sin motivo → 400) | **PASA** |
| P14 | Verificación pública del sorteo | `tests/s7-draw-winner.test.ts` — "P14: la verificación pública reproduce el ganador (lib y script)" + "determinismo…", "reproducibilidad independiente lib vs script: 1, 2 y 10.000 elegibles"; `tests/draw.test.ts` (7 tests) | **PASA** |
| P15 | Agregar un país ya soportado | `tests/s3-raffles-countries.test.ts` — "P15: POST /api/admin/countries crea el país con los 16 campos, sin tocar código" + "código duplicado → 409…" | **PASA** |
| P16 | Checkout dinámico por país | `tests/s9-integration.test.ts` — "GET /api/payment-methods?country=DO devuelve el método manual; país desconocido → []"; verificado además con el seed real en S10 (solo `MANUAL_TRANSFER` para DO; PayPal/Azul/CardNet no aparecen) | **PASA** |
| P17 | Nueva pasarela como adaptador | **S10** `tests/s10-p1-p28.test.ts` — "un adaptador nuevo implementa la interfaz PaymentProviderAdapter completa y pasa su prueba de sandbox sin tocar el núcleo" (hueco: el seam existía —registro + MockProvider de S5— sin test de pasarela nueva). Nota: el registro es un `Record` fijo de 4 códigos; registrar una pasarela nueva es añadir su entrada en `registry.ts` + su código en `ProviderCode` + su fila en BD, sin tocar pedidos/ledger/comisiones (plan §2.2 C: el adaptador se desarrolla una vez) | **PASA** |
| P18 | Gate de activación por país | `tests/s3-raffles-countries.test.ts` — "P18: gate de activación — sin verificación → 409 con motivos; con ambas → 200" + "P18 (lib): checkActivationGate devuelve los motivos exactos" | **PASA** |
| P19 | Pedido y recuperación de operación incompleta | `tests/s4-orders-tickets.test.ts` — "P19: pago confirmado sin boletos → recuperación emite boletos sin duplicar" + "P19 sin pago confirmado → 409" | **PASA** |
| P20 | Reintento de pago tras caída | `tests/s4-orders-tickets.test.ts` — "P20: reintento tras caída (3x, misma clave, secuencial y concurrente) → un solo pedido/cobro/boletos" | **PASA** |
| P21 | Conciliación detecta discrepancia | `tests/s5-payments.test.ts` — "P21: webhook aprobado sin pedido → caso pago-sin-pedido, sin inventar venta" + "P21: reconcile detecta pago-sin-pedido y pedido-sin-pago; segunda pasada no duplica casos" | **PASA** |
| P22 | Fraude: compra masiva / bot marcado | `tests/s6-ledger-affiliates-fraud.test.ts` — bloque "P22 — fraude…" (8 tests: velocidad 5/60 min, auto-referido, duplicados, reembolsos, contracargo, revisión humana, holdCommission) | **PASA** |
| P23 | Ganador y entrega completos | `tests/s7-draw-winner.test.ts` — "P23: flujo completo hasta CASO_CERRADO con evidencia; la rifa pasa a FINALIZADA" + "no se puede cerrar sin evidencia…; saltarse pasos y retroceder → 409" + "ganador que no responde — procedimiento de las bases…" + "renuncia y no elegible…" | **PASA** |
| P24 | Notificación fallida no rompe la compra | `tests/s8-notifications-support.test.ts` — bloque "P24 — notificación fallida no rompe la compra" (5 tests: reintentos con backoff, sin `RESEND_API_KEY` queda PENDIENTE, dedupe, `queueNotificationSafe` nunca lanza) | **PASA** |
| P25 | Reclamación genera ticket | `tests/s8-notifications-support.test.ts` — "P25 — reclamación 'pagué y no recibí mi boleto' genera ticket" + stats; `tests/contract-gaps.test.ts` — hueco 1 (ticket público `TKT-000001`, prioridad ALTA) | **PASA** |
| P26 | Bases versionadas por comprador | `tests/s3-raffles-countries.test.ts` — "POST crea v1 y luego v2; v1 queda inmutable…" + "P26 (lib): la aceptación vincula al comprador con la versión vigente…" | **PASA** |
| P27 | Moneda: sin recálculo retroactivo | **S10** `tests/s10-p1-p28.test.ts` — "cada transacción conserva su moneda y valor originales; los saldos son por moneda; el reporte global no mezcla monedas" (hueco: los snapshots existían, sin test; el reporte mezclaba monedas — corregido en S10, ver §4) | **PASA** |
| P28 | Control de cambios registra antes/después | `tests/s3-raffles-countries.test.ts` — "cambio de precio CON ventas + segundo superadmin → 200, ChangeLog antes/después y aviso al comprador" (mismo bloque que P13) | **PASA** |

**Total: 28/28 PASA** (5 de ellas cerradas por tests nuevos de S10: P3, P9, P12, P17, P27). Suite total: **247 tests en 18 archivos, 247/247**.

### 3.2 Checklist de lanzamiento (plan §5.4, 18 ítems)

| # | Ítem | Estado | Evidencia / motivo exacto |
|---|---|---|---|
| 1 | Compra real de prueba completada correctamente | **BLOQUEADO** | Compra end-to-end verificada solo en test (S4/S5/S9). Falta la compra de prueba del dueño **con dinero real** (gate de salida de Fase 1, plan §3). Solo la puede hacer el dueño. |
| 2 | Pago confirmado y conciliado | **BLOQUEADO** | Conciliación verificada con MockProvider (P21). Con pasarela real no hay nada que conciliar aún: ninguna pasarela está operativa salvo transferencia manual (regla 6). Requiere pasarela verificada + compra real. |
| 3 | Boletos únicos, sin duplicación | **PASA** | P1: 100 concurrentes → 1 ganador, 99 con 409; unicidad `(rifa, número)` en BD. |
| 4 | Reserva y expiración comprobadas | **PASA** | P5 + job liberador idempotente; expiración de pendientes manuales 24 h (S5). |
| 5 | Comisiones calculadas correctamente | **PASA** | P6 + tests de comisión (1000 → 100, redondeo a enteros, sin floats). |
| 6 | Reembolso probado | **PASA** | P6: reembolso con asiento compensatorio + ajuste de comisión + boletos liberados; contracargo con movimiento de dinero (S9). |
| 7 | Webhook duplicado probado | **PASA** | P4 (duplicado y triple envío sin efectos). Firma inválida → 401 sin efectos. |
| 8 | Sorteo verificado independientemente | **PASA** | P14: verificación lib vs `scripts/verify-draw.mjs` en 1, 2 y 10.000 elegibles; compromiso público pre-sorteo sin revelar la semilla. |
| 9 | Ganador y entrega del premio documentados | **PASA** | P23: flujo completo hasta CASO_CERRADO con evidencia; procedimientos de no elegible/renuncia/sin respuesta registrados. |
| 10 | Permisos administrativos comprobados | **PASA** | P11: matriz RBAC de 7 roles en lib y en endpoints (403/401). |
| 11 | Seguridad revisada | **PASA** | 2FA obligatorio para admins + recuperación sin atajos (8 tests de salto), sesiones revocables, rate limiting, webhooks firmados, secretos solo por entorno. Sin auditoría externa de seguridad (no exigida por el plan para Fase 1). |
| 12 | Backups restaurados exitosamente en prueba | **PASA** | P10: backup + `scripts/restore-test.mjs` verifican ventas, boletos, comisiones y saldos. La prueba de restauración mensual en producción queda como operación recurrente del dueño. |
| 13 | Pasarela autorizada para la actividad | **BLOQUEADO** | Solo transferencia manual es operativa. Azul y CardNet exigen afiliación (RNC + cuenta comercial + homologación, semanas) y PayPal exige verificación real + autorización para rifas. Nada de esto lo puede hacer el equipo sin el dueño. Regla 6. |
| 14 | Bases y requisitos legales revisados | **BLOQUEADO** | Licencia del Ministerio de Hacienda y registro en Pro Consumidor (RD$500, solicitud ≥21 días antes del lanzamiento) pendientes. El seed deja DO con `legalVerified=false` / `providerVerified=false` a propósito; el gate de S3 bloquea activaciones sin verificación. Solo el dueño (con abogado) puede resolverlo. |
| 15 | Monitoreo y alertas funcionando | **PASA** | 10 alertas (§2.19) + `GET /api/admin/health` verificados en tests (S8). Caveat: el envío real de correo depende de `RESEND_API_KEY`, que el dueño debe entregar por Secure Vault; sin ella los correos quedan PENDIENTE sin romper nada (P24). |
| 16 | Prueba en móvil, tablet y computadora | **BLOQUEADO** | Diseño mobile-first existe, pero no hay evidencia registrada de prueba en dispositivos reales (móvil/tablet/computadora). Pendiente de prueba manual del dueño o del equipo con dispositivos. |
| 17 | Plan de rollback probado | **BLOQUEADO** | El procedimiento está documentado (`docs/jobs.md`: staging → producción con verificación y rollback), pero no existe entorno staging ni se ejecutó un simulacro de rollback. Pendiente de montar staging + probar el rollback. |
| 18 | Sin errores críticos o bloqueantes | **PASA** | Suite 247/247, `tsc` 0 errores, `npm run build` exit 0, smoke 13/13 en 200. No hay errores críticos conocidos en el código; los pendientes son los riesgos del §5, no defectos. |

**Resultado: 12/18 PASA, 6/18 BLOQUEADO (ítems 1, 2, 13, 14, 16, 17). El lanzamiento a producción con dinero real está BLOQUEADO** hasta resolver, como mínimo, los ítems 1, 2, 13 y 14 (compra real, conciliación real, pasarela autorizada, legal). Los ítems 16 y 17 son operativos y pueden cerrarse en paralelo.

---

## 4. Errores encontrados y corregidos

**Errores importantes de cada subfase (recogidos del log de validación de `EJECUCION-v2.2.md`):**

- **S0/S1/S2:** 4 errores de `tsc` del frontend señalados por S9-parcial en archivos del backend (`audit.ts`, `ledger.ts`, `tests/setup.ts`) — corregidos por el backend. Comisión estandarizada a por ciento (`COMMISSION_RATE="10"` = 10%, no 0.10 como fracción) con test 1000 → 100. El sandbox bloquea `binaries.prisma.sh`: el engine se descargó con curl y `PRISMA_SCHEMA_ENGINE_BINARY` quedó en `.env` (gitignorado); en instalación limpia puede repetirse el paso.
- **S3:** el test de support-ticket hacía ABIERTO → RESUELTO directo; la máquina de S8 lo rechaza correctamente — test corregido a ABIERTO → EN_REVISION → RESUELTO.
- **S4:** el fallo 172/173 de su suite (support-ticket 409) era anterior a la corrección del test del coordinador; verificado 15/15 después. Afirmación incorrecta de S4 sobre `tests/setup.ts` (sí respeta `DATABASE_URL`).
- **S5:** el test S4 del receipt usaba `receipt.json()` por defecto — actualizado a `?format=json` (el cambio a PDF binario real era intencionado). `expire-pending-orders` añadido a `KNOWN_JOBS` por el coordinador (S5 no podía tocar `src/lib/jobs.ts`).
- **S6:** 2 tests S8 con expectativas obsoletas (esperaban `reconcile-provider` MISSING) — actualizados a COMPLETED; suite pasó a 224/224.
- **S7:** afirmación incorrecta sobre `tests/setup.ts`; su workaround con cwd `/tmp/s7db` era innecesario (el fallo P10 de su corrida fue artefacto del cwd, no del producto).
- **S9:** 1 error real de `tsc` en `tests/s9-integration.test.ts(197,7)` (`draw.seed` es `string | null`) pese a reportar 0 errores — corregido con aserción + `!`. 16 desajustes frontend corregidos (ver log S9).
- **S10 (esta subfase):**
  1. **Defecto real P27 (corregido):** `GET /api/admin/reports` sumaba pedidos de monedas distintas en una misma fila, etiquetada con la moneda del primer pedido — un recálculo implícito que reescribía el valor original. Corregido: la clave de agrupación incluye la moneda; el campo `group` visible no cambia. Test P27 lo cubre (DOP 200 + USD 100 en filas separadas). En Fase 1 (solo DO/DOP) el comportamiento no cambia.
  2. **Nota de S9 incorrecta (corregida, sin cambio de código):** el seed SÍ crea `PaymentMethod` y `CountryPaymentConfig` desde el primer commit; verificado con el seed real (ver §2). No hizo falta añadir nada al seed.
  3. **Errores de autoría de los tests S10 (corregidos antes de pasar):** la aserción P3 buscaba los boletos liberados por `orderId` cuando `failOrderPayment` los desvincula (`orderId: null`) — se busca por rifa+número; `seedManual()` no era idempotente y fallaba al llamarse dos veces en el test P27 — ahora usa `upsert`; el test P12 buscaba una fila DISPONIBLE inexistente (las filas de boleto se crean al comprar) y trataba de bloquear un VENDIDO (la API solo bloquea DISPONIBLE) — se crea la fila directamente y se verifica que bloquear un VENDIDO da conflicto. Además, mi primera versión de la corrección P27 puso `group: key` (con la moneda dentro del campo visible) — corregido a `group: baseKey`.

**No se encontró ningún problema técnico que obligue a cambiar una decisión de arquitectura (regla 8): no hubo que detenerse.**

---

## 5. Riesgos pendientes (lista final para el dueño)

1. **Legal (RIESGO #1 del plan):** sin licencia de Hacienda ni registro en Pro Consumidor no se cobra dinero real. Solicitud ≥21 días antes del lanzamiento. (Checklist 14, BLOQUEADO.)
2. **Pasarelas NO operativas:** Azul, CardNet y PayPal son skeleton NO operativo (503) hasta afiliación real + autorización expresa para la actividad de rifas + conciliación (regla 6). Solo la transferencia manual opera hoy. (Checklist 13, BLOQUEADO.)
3. **PayPal sin probar contra PayPal real:** la verificación de firma vía API oficial está implementada pero nunca se ejerció contra PayPal (sin credenciales ni sandbox). No fingirla: sin credenciales responde 503.
4. **P1 bajo PostgreSQL pendiente:** P1 se verificó con 100 concurrentes reales en SQLite, que serializa las escrituras. La contención real bajo PostgreSQL (bloqueos de fila) queda pendiente de un entorno Postgres. El código usa transacciones Prisma compatibles con Postgres, pero la prueba de carga real no se ha hecho.
5. **P9 es un reinicio simulado:** el test desconecta y reconecta el pool de Prisma; no se probó un reinicio real del proceso/servidor ni una caída a mitad de transacción. Los datos viven en la BD (no en memoria), así que el riesgo es bajo, pero el simulacro de caída real queda pendiente.
6. **Umbral de doble aprobación en retiros (RD$10.000) sin confirmar por el dueño:** el plan dice "retiro grande" sin cifra; S6 fijó 10.000. El dueño debe confirmar o cambiar `WITHDRAWAL_DOUBLE_APPROVAL_THRESHOLD`.
7. **Huella de dispositivo no implementada:** el plan §2.14 menciona "mismo dispositivo" como señal de fraude, pero el schema no tiene huella de dispositivo (el `Click` solo guarda IP). Si el dueño la quiere, es cambio de modelo (Fase 2).
8. **Envío real de correo sin probar:** sin `RESEND_API_KEY` (la debe entregar el dueño por Secure Vault) los correos quedan PENDIENTE; WhatsApp/SMS son stub de Fase 2. Las notificaciones nunca rompen la compra (P24), pero el canal de correo real no está verificado.
9. **Contracargo y reembolso con comisión ya pagada:** cubierto (saldo negativo absorbible + job `compensate-paid-commissions`), pero el flujo completo con una pasarela real no se ha ejercido.
10. **Reporte `/admin/stats` suma monedas sin separarlas:** el dashboard agrega todos los pedidos en un solo número (igual que hacía `/reports` antes de la corrección S10). En Fase 1 no hay impacto (solo DOP activo), pero antes de activar un segundo país hay que separar por moneda también en `stats` (trabajo de Fase 2/3, no de S10: es agregación de presentación, no pérdida de datos — los valores originales se conservan).
11. **Rate limiting en memoria:** a Redis en Fase 2 si hay varias instancias. Un solo servidor en Fase 1.
12. **Semilla del sorteo en claro en `Draw.seed`:** decisión documentada de S7 (protegerla por no exponerla en API + auditoría; cifrarla crearía dependencia de `TOTP_ENCRYPTION_KEY` cuya pérdida bloquearía sorteos comprometidos). Revisar si el dueño prefiere cifrado.
13. **Sin entorno staging ni simulacro de rollback** (checklist 17) y **sin prueba en dispositivos reales** (checklist 16).
14. **Compra de prueba con dinero real pendiente** (checklist 1–2): gate de salida de Fase 1.
15. **Primera rifa sin definir:** premio, precio, total de boletos y fecha de sorteo los decide el dueño cuando la plataforma esté lista para publicar; la rifa demo del seed es BORRADOR sin licencia y no es publicable.

---

## 6. Evidencia de funcionamiento

- Suite completa final: **247/247 tests en 18 archivos** (`DATABASE_URL="file:./test-s10.db"`, ~6,5 min). Antes de S10: 239/239 en 17 archivos. S10 añadió 8 tests, 0 regresiones.
- `npx tsc --noEmit`: **0 errores**.
- `npm run build`: **exit 0** (33/33 rutas en S9; el build de S10 lista las mismas rutas, ver §2).
- Smoke HTTP (producción, puerto 3000): **13/13 rutas 200** (públicas y admin principales).
- Seed real ejecutado 2 veces sobre BD fresca: idempotente; `GET /api/payment-methods?country=DO` → 200 con solo transferencia manual.
- Sorteo verificable: `scripts/verify-draw.mjs` reproduce el ganador desde semilla + lista congelada (P14).
- Backup: `scripts/restore-test.mjs` + test P10 (S8).
- Archivos: este informe en `docs/fase1-informe.md`; tests nuevos en `tests/s10-p1-p28.test.ts`; corrección en `src/app/api/admin/reports/route.ts`.

---

## 7. Confirmación de no regresión

Suite completa final en BD aislada de S10: **247/247, 18 archivos, 0 fallos**. Ningún test de otras subfases se tocó ni se rompió (S10 solo añadió `tests/s10-p1-p28.test.ts` y corrigió `src/app/api/admin/reports/route.ts`; la corrección no cambia el comportamiento con una sola moneda, y los tests S9 de `/reports` siguen pasando dentro de la suite). `tsc` 0 errores y `build` exit 0 confirman que no hay regresión de tipos ni de compilación.

---

## 8. Decisiones aparcadas (resueltas o dejadas por escrito)

- **(a) Doble aprobación en dos pasos vs `approvedById` pragmático (S3):** queda el pragmático implementado: en retiros, la 1ª aprobación queda en `approvedById` y la 2ª (de otro admin) en ChangeLog + AuditLog; en cambios de rifa, el segundo SUPERADMIN aprueba en el mismo PATCH y queda en ChangeLog antes/después + aviso al comprador. Si el dueño quiere el flujo en dos pasos (solicitud → aprobación separada), es trabajo de Fase 2, no de S10. El umbral de RD$10.000 para retiros sigue pendiente de confirmación del dueño (riesgo 6).
- **(b) Transiciones estrictas del ganador vs saltos del frontend:** resuelto en S9 — el backend solo permite el siguiente paso (o el mismo estado con evidencia); el frontend ofrece solo el siguiente paso. Test S9: saltar PENDIENTE_CONTACTO → VERIFICACION → 409.
- **(c) Publicación de nombres en `GET /api/winners`:** sigue sin exponer nombres (no hay campo de consentimiento en el schema). Conforme al plan (§2.5: solo lo que el ganador autorice). Si el dueño quiere publicar nombres, es cambio de modelo a aprobar — no se hizo en S10.

---

## 9. Qué falta para lanzar (resumen para el dueño)

1. Verificación legal: licencia Hacienda + registro Pro Consumidor (≥21 días antes).
2. Formalización para pagos: RNC + cuenta comercial; afiliación Azul o CardNet (semanas) y/o verificación PayPal + autorización para rifas.
3. Entregar `RESEND_API_KEY` por Secure Vault para el correo real.
4. Confirmar el umbral de doble aprobación de retiros (RD$10.000) y decidir sobre la huella de dispositivo y el cifrado de la semilla del sorteo.
5. Montar staging, probar el rollback, probar en móvil/tablet/computadora.
6. Definir la primera rifa y hacer la compra de prueba con dinero real + reembolso de prueba + conciliación.
7. Verificar P1 bajo PostgreSQL en el entorno de producción antes de un pico de ventas.
