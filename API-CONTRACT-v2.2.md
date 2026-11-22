# CONTRATO API v2.2 — PRENDE RIFAS

**Fuente de verdad funcional:** `plan-tecnico-v2.md` v2.2. Este documento fija el contrato entre backend (A) y frontend (B). Si hay conflicto, manda el plan; si el contrato no cubre algo, el implementador lo marca como hueco en su reporte en vez de inventarlo.

## Convenciones
- Base `/api`. Todo JSON. Errores: `{ "error": "mensaje" }` con HTTP 400 validación, 401 no autenticado, 403 sin permiso, 404 no existe, 409 conflicto (ej. boleto ya vendido), 503 proveedor no configurado.
- Auth: cookie httpOnly `pr_session` (JWT con `jose`). El rol NUNCA viene del cliente.
- Dinero: enteros en unidades mayores de la moneda (100 = RD$100). Nunca floats.
- Paginación: `?page=&limit=` (defecto 20, máx 100). Respuesta de listas: `{ "data": [...], "page": n, "total": n }`.
- Idempotencia: los POST de compra/pago aceptan header `Idempotency-Key`; repetir la misma clave devuelve el mismo resultado sin efectos duplicados.
- Validación con zod en todos los endpoints.

## Enums
- `Role`: `SUPERADMIN | ADMIN_RIFAS | FINANZAS | AUDITOR | MARKETING | AFILIADO | CLIENTE`
- `RaffleStatus`: `BORRADOR | PENDIENTE_APROBACION | PROGRAMADA | ACTIVA | PAUSADA | AGOTADA | CERRADA | EN_SORTEO | GANADOR_PUBLICADO | FINALIZADA | CANCELADA`
- `TicketStatus`: `DISPONIBLE | RESERVADO | VENDIDO | ANULADO | BLOCKED` (ELEGIBLE se calcula al congelar la lista para el sorteo; no es un estado almacenado del boleto. `BLOCKED` = bloqueado por admin, no se vende mientras tanto).
- `WithdrawalStatus`: `REQUESTED | APPROVED | PAID | REJECTED`
- `OrderStatus`: `PENDIENTE | CONFIRMADO | FALLIDO | EXPIRADO | REEMBOLSADO | DISPUTADO`
- `PaymentStatus`: `PENDIENTE | APROBADO | FALLIDO | REEMBOLSADO | CONTRACARGO`
- `PaymentMethodCode`: `MANUAL_TRANSFER | PAYPAL | AZUL_CARD | CARDNET_CARD` — en Fase 1 solo `MANUAL_TRANSFER` es operativo; los demás responden 503 `NOT_CONFIGURED` hasta verificación real (regla 6 del plan).
- `CountryStatus`: `BORRADOR | CONFIGURACION | REVISION | ACTIVO`
- `WinnerCaseStatus`: `PENDIENTE_CONTACTO | CONTACTADO | VERIFICACION | PREMIO_ACEPTADO | ENTREGA_COORDINADA | ENTREGADO | CASO_CERRADO`
- `RiskStatus`: `NORMAL | REVISION | RETENIDO | APROBADO | BLOQUEADO`
- `TicketStatus` de soporte: `ABIERTO | EN_REVISION | ESPERANDO_CLIENTE | RESUELTO | CERRADO`

## Auth — `/api/auth`
| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/api/auth/register` | público | `{name,email,password}` → CLIENTE. Respuesta `{user}` (sin passwordHash). |
| POST | `/api/auth/register-afiliado` | público | `{name,email,password}` → AFILIADO + `referralCode` único. |
| POST | `/api/auth/login` | público | `{email,password}` → cookie `pr_session` + `{user}`. Si el usuario tiene 2FA activo, responde 202 `{requires2FA:true}` y luego `POST /api/auth/login-2fa {email, code}` completa el login. |
| POST | `/api/auth/logout` | auth | Revoca la sesión. |
| GET | `/api/auth/me` | auth | Usuario actual + roles/permisos. |
| POST | `/api/auth/2fa/setup` | ADMIN* | Inicia 2FA TOTP: devuelve `otpauthUrl` + `backupCodes` (mostrar una sola vez). |
| POST | `/api/auth/2fa/verify` | ADMIN* | `{code}` activa 2FA. |
| POST | `/api/auth/2fa/disable` | ADMIN* | Requiere contraseña + código 2FA vigente; queda en auditoría. |
| POST | `/api/auth/recover` | público | Inicio de recuperación de cuenta admin (ver `docs/recuperacion-admin-2fa.md`): genera solicitud registrada; NO salta 2FA. |

(*) 2FA obligatorio para todos los roles administrativos (SUPERADMIN, ADMIN_RIFAS, FINANZAS, AUDITOR, MARKETING).

## Público
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/raffles?status=ACTIVA&country=DO` | Lista con `soldCount`, `percentSold`, `availableCount`, `currency`, `country`, `drawAt`, `prize`, `imageUrl`. |
| GET | `/api/raffles/[id]` | Detalle + `soldNumbers: number[]` y `reservedNumbers: number[]` (para el selector) + `termsVersion` vigente + `licenseNumber` (si existe). |
| GET | `/api/tickets/verify?code=` | Ticket + rifa + si ganó (sí/no). Sin exponer datos privados de otros. |
| GET | `/api/draws/[raffleId]` | Resultado público verificable: `commitment`, `seed` (revelada tras el sorteo), `hashElegibles`, `totalElegibles`, `winnerTicketNumber`, `algorithm`, `executedAt`, `drawId`. |
| GET | `/api/draws/[raffleId]/commitment` | Compromiso pre-sorteo (plan §2.5): `commitment`, `hashElegibles`, `totalElegibles`, `algorithm`, `publishedAt`, `executedAt`, `seedRevealed`. La semilla NUNCA se revela aquí; solo tras ejecutar el sorteo en `GET /api/draws/[raffleId]`. 404 si el compromiso aún no se publicó. |
| GET | `/api/winners` | Ganadores publicados (número de boleto + rifa + fecha; sin datos personales salvo autorización). |
| GET | `/api/payment-methods?country=DO` | Métodos habilitados para ese país (solo los activos; nunca métodos no disponibles). |
| GET | `/api/r/[code]` | (página, no API) registra clic de afiliado y redirige. |

## Compra (checkout)
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/raffles/[id]/reserve` | `{numbers?: number[], quantity?: number, buyerEmail}` → crea reserva ~10 min (`reservationId`, `expiresAt`, `numbers`). 409 si un número ya no está disponible (con sugerencia de cercanos). Requiere `Idempotency-Key`. |
| POST | `/api/raffles/[id]/purchase` | `{reservationId?, numbers?, quantity?, paymentMethodCode, affiliateCode?, buyerName, buyerEmail, buyerPhone?}` → `{order, tickets, paymentInstructions?}`. Sin registro obligatorio (compra invitada). Crea Order PENDIENTE + Payment PENDIENTE. Si `paymentMethodCode=MANUAL_TRANSFER`, devuelve instrucciones de transferencia. Requiere `Idempotency-Key`. |
| GET | `/api/orders/[code]` | Público por código: estado del pedido, boletos, pago. |
| GET | `/api/orders/mine` | Auth: historial de compras del usuario. |
| GET | `/api/orders/[code]/receipt` | Comprobante descargable (PDF con QR). |

## Webhooks (solo servidor, firma verificada; sin firma válida → 401)
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/payments/webhook/paypal` | Webhook PayPal (skeleton Fase 1: verifica firma; sin credenciales → 503). |
| POST | `/api/payments/webhook/azul` | Webhook Azul (skeleton Fase 1: 503 hasta afiliación real). |
| POST | `/api/payments/webhook/cardnet` | Webhook CardNet (skeleton Fase 1: 503 hasta afiliación real). |

## Afiliado
| Método | Ruta | Rol |
|---|---|---|
| GET | `/api/affiliates/me` | AFILIADO: stats (clicks, sales, commissionPending, commissionRetained, commissionAvailable, balance, referralLink). |
| GET | `/api/affiliates/me/sales` | AFILIADO: ventas atribuidas (con ventana 7 días, último clic). |
| POST | `/api/affiliates/withdraw` | AFILIADO: `{amount}` ≥ mínimo configurable (def. RD$500). |
| POST | `/api/affiliates/click` | Público: `{code, raffleId?}` registra el clic de afiliado (la página `/r/[code]` lo llama fire-and-forget). Alimenta la ventana de atribución de 7 días. 404 si el código no existe. |

## Soporte (público)
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/support-tickets` | Público: `{type, buyerEmail, orderCode?, message}` → ticket con número único (`TKT-000123`). `type`: `PAGO_SIN_BOLETO \| CONSULTA_BOLETO \| PAGO_RECHAZADO \| PROBLEMA_COMPRA \| DEVOLUCION \| DUDA_GANADOR \| OTRO`. Si viene `orderCode`, se enlaza al pedido. |
| GET | `/api/support-tickets/mine` | Auth: tickets del usuario (por cuenta, por sus pedidos o por su email). |

## Admin — `/api/admin` (rol según matriz; cada endpoint verifica el permiso)
- `GET /api/admin/stats` — dashboard (ventas, pendientes, reembolsos, contracargos, comisiones, ganancia, % vendido, ritmo, conversión, alertas).
- Rifas: `POST /api/admin/raffles`, `PATCH /api/admin/raffles/[id]` (cambios sensibles con ventas → aprobación + aviso + auditoría), `POST /api/admin/raffles/[id]/transition {to}` (máquina de 11 estados), `GET /api/admin/raffles?status=&country=&page=&limit=` (filtros: `status` uno de los 11 estados de `RaffleStatus`, `country` código ISO; paginación `page`/`limit` como en el resto de listas).
- Pedidos: `GET /api/admin/orders?status=`, `POST /api/admin/orders/[id]/confirm` (transferencia verificada → CONFIRMADO + comisiones), `POST /api/admin/orders/[id]/cancel` (libera boletos), `POST /api/admin/orders/[id]/refund` (reembolso + ajuste de comisión).
- Boletos: `GET /api/admin/tickets?raffleId=`, `POST /api/admin/tickets/[id]/block|unblock|annul {reason}` (anulación con motivo; si estaba pagado, dispara reembolso).
- Sorteo: `POST /api/admin/raffles/[id]/draw/commit` (congela elegibles + publica commitment), `POST /api/admin/raffles/[id]/draw/execute` (revela semilla + ganador; bloqueado si hay pagos/reservas sin resolver o si ya se sorteó), `GET /api/admin/draws/[id]`.
- Ganador: `GET /api/admin/winners`, `PATCH /api/admin/winners/[id]` (avanza estados del caso; evidencia de entrega). Cuerpo estandarizado: `{status, evidence?, note?}`; `status` es uno de los 7 estados de `WinnerCaseStatus`. `evidence` se fusiona con la evidencia guardada; `note` se añade a las notas del caso y queda en auditoría.
- Afiliados: `GET /api/admin/affiliates`, `GET /api/admin/withdrawals`, `POST /api/admin/withdrawals/[id]/pay|reject` (con registro de quién aprobó).
- Pagos: `GET /api/admin/payments`, `GET /api/admin/reconciliation` (casos + reporte por proveedor/período), `POST /api/admin/reconciliation/run`.
- Métodos: `GET|POST /api/admin/payment-methods`, `PATCH|DELETE /api/admin/payment-methods/[id]`.
- Integraciones: `GET /api/admin/integrations` (estado de cada proveedor preintegrado: código, nombre, tipo, `status`, `sandboxMode`, `credentialsConfigured`, `credentialKeys`, `authorizedForRaffles`, última prueba de sandbox, `gate: {ok, reasons}`), `POST /api/admin/integrations/[provider]/test-sandbox` (prueba en sandbox por código de proveedor: `MANUAL_TRANSFER | PAYPAL | AZUL | CARDNET`; sin credenciales/integración real → 503 `NOT_CONFIGURED`). Credenciales: se envían en el PATCH del proveedor como `{credentials: {...}}`, solo campos no vacíos (se fusionan con las guardadas, se cifran AES-256-GCM en BD y NUNCA se devuelven valores guardados; la API solo expone `credentialsConfigured` y `credentialKeys`). Secretos sueltos en el body (`apiKey`, `secret`, `password`, etc.) se rechazan con 400.
- Países: `GET|POST /api/admin/countries`, `GET /api/admin/countries/[id]` (detalle + configuración de pagos por proveedor/método), `PATCH /api/admin/countries/[id]` ("Agregar país": 16 campos; estados; clasificación A/B/C), `POST /api/admin/countries/[id]/activate` (gate: legal + proveedor; si no pasa, 409 con motivo).
- Bases: `GET /api/admin/terms` (lista versiones; `?raffleId=` filtra por rifa), `POST /api/admin/terms` (`{raffleId, content}` crea la versión n+1 y la marca vigente en la rifa; las versiones viejas nunca se editan ni se borran).
- Config: `GET|PATCH /api/admin/settings` (COMMISSION_RATE, RETENTION_DAYS, MIN_WITHDRAWAL, RESERVATION_MINUTES, etc.).
- Reportes: `GET /api/admin/reports?groupBy=day|raffle|country`.
- Auditoría: `GET /api/admin/audit-log`, `GET /api/admin/change-log`.
- Soporte: `GET /api/admin/support-tickets`, `PATCH /api/admin/support-tickets/[id]`. Cuerpo estandarizado: `{status, assignee?, note?}`; `status` es uno de `ABIERTO | EN_REVISION | ESPERANDO_CLIENTE | RESUELTO | CERRADO`; `assignee` es el id del usuario admin responsable (null para desasignar); `note` queda en auditoría. `RESUELTO`/`CERRADO` marcan `resolvedAt`.
- Fraude: `GET /api/admin/fraud-cases`, `PATCH /api/admin/fraud-cases/[id]` (revisión humana). Cuerpo estandarizado: `{riskStatus, decision?, note?}`; `riskStatus` es uno de `NORMAL | REVISION | RETENIDO | APROBADO | BLOQUEADO`; `decision` registra qué se decidió; `APROBADO`/`BLOQUEADO` cierran el caso (`resolvedAt`).
- Notificaciones: `GET /api/admin/notifications` (cola, entregas, fallidos).
- Monitoreo: `GET /api/admin/health` (estado del sistema, colas, jobs, backups).

## Formas de respuesta (resumen)
- `Raffle`: `{id, title, description, prize, imageUrl, country, currency, ticketPrice, totalTickets, drawAt, status, rules, termsVersionId, licenseNumber, soldCount, percentSold, availableCount}`. El detalle `GET /api/raffles/[id]` añade además `soldNumbers: number[]` y `reservedNumbers: number[]`.
- `Ticket`: `{id, number, code, status, raffleId, orderId, buyerName}` (buyerEmail/buyerPhone solo para el dueño o admin).
- `Order`: `{id, code, raffleId, buyerName, buyerEmail, totalAmount, currency, status, paymentMethodCode, affiliateCode, tickets: [{number, code}], createdAt}`.
- `Draw` público: `{drawId, raffleId, commitment, seed, hashElegibles, totalElegibles, winnerTicketNumber, winnerTicketCode, algorithm, executedAt}`.
- `User`: `{id, name, email, role, referralCode?}` — nunca `passwordHash`, nunca secretos 2FA.

## Ejemplos de respuesta (admin)
Formato de listas: `{ "data": [...], "page": n, "total": n }` (salvo `health` y `stats`, que son objetos).

- `GET /api/admin/countries` — `{ "data": [{ "id": "…", "code": "DO", "name": "República Dominicana", "currencyCode": "DOP", "currencySymbol": "RD$", "timezone": "America/Santo_Domingo", "classification": "A", "status": "ACTIVO", "legalVerified": false, "providerVerified": false }], "page": 1, "total": 1 }`
- `GET /api/admin/countries/[id]` — igual que arriba + `"paymentConfigs": [{ "provider": { "code": "MANUAL_TRANSFER", "name": "Transferencia manual", "status": "OPERATIVO" }, "method": { "code": "MANUAL_TRANSFER", "label": "Transferencia bancaria" }, "priority": 1, "enabled": true }]`
- `GET /api/admin/winners` — `{ "data": [{ "id": "…", "raffleId": "…", "status": "PENDIENTE_CONTACTO", "evidence": null, "contactLog": null, "notes": null, "createdAt": "…", "updatedAt": "…" }], "page": 1, "total": 0 }`
- `GET /api/admin/support-tickets` — `{ "data": [{ "id": "…", "number": "TKT-000001", "type": "PAGO_SIN_BOLETO", "status": "ABIERTO", "priority": "ALTA", "subject": "Pagué y no recibí mi boleto", "buyerEmail": "cliente@ejemplo.do", "orderId": "…", "ownerId": null }], "page": 1, "total": 1 }`
- `GET /api/admin/fraud-cases` — `{ "data": [{ "id": "…", "rule": "velocity-purchase", "reason": "12 boletos en 2 minutos desde la misma IP", "status": "REVISION", "entityType": "Order", "entityId": "…", "reviewedById": null, "decision": null }], "page": 1, "total": 0 }`
- `GET /api/admin/notifications` — `{ "data": [{ "id": "…", "event": "pago_confirmado", "channel": "EMAIL", "recipient": "cliente@ejemplo.do", "status": "ENTREGADO", "attempts": 1, "sentAt": "…" }], "page": 1, "total": 1 }`
- `GET /api/admin/health` — `{ "status": "ok", "database": "ok", "jobs": { "release-expired-reservations": { "lastRun": "…", "status": "COMPLETED" } }, "queues": { "notifications": { "pending": 0, "failed": 0 } }, "lastBackupAt": "…" }`
- `GET /api/admin/stats` — `{ "salesGross": 125000, "salesConfirmed": 120000, "pendingOrders": 3, "refunds": 0, "chargebacks": 0, "commissionsGenerated": 12000, "commissionsRetained": 8000, "commissionsPaid": 0, "profitEstimated": 45000, "alerts": [{ "type": "raffle-slow", "raffleId": "…", "message": "Sorteo en 3 días y menos del 50% vendido" }] }`
- `GET /api/admin/reports?groupBy=day` — `{ "data": [{ "group": "2026-11-21", "sales": 25000, "orders": 12, "ticketsSold": 25, "refunds": 0 }], "page": 1, "total": 1 }`
- `GET /api/admin/integrations` — `{ "data": [{ "provider": "MANUAL_TRANSFER", "name": "Transferencia manual", "type": "MANUAL", "status": "OPERATIVO", "sandboxMode": false, "credentialsConfigured": false, "credentialKeys": [], "authorizedForRaffles": true, "lastSandboxTestAt": null, "lastSandboxTestPassed": null, "verifiedAt": "…", "gate": { "ok": true, "reasons": [] } }, { "provider": "AZUL", "name": "Azul (Banco Popular)", "type": "GATEWAY", "status": "NO_OPERATIVO", "gate": { "ok": false, "reasons": ["Faltan credenciales (introducir referencia segura desde el panel)", "La prueba de sandbox no ha sido superada", "Falta la autorización del proveedor para la actividad de rifas"] } }] }` — nunca incluye valores de credenciales.

## Jobs (servidor, resistentes — regla 3 del plan)
- `release-expired-reservations` (cada minuto): libera reservas vencidas; idempotente por `reservationId`.
- `reconcile-provider` (diario + bajo demanda): compara internos vs proveedor; discrepancia → alerta + caso.
- `notification-dispatch` (continuo): cola con reintentos y dedupe.
- `backup-daily`: backup de base de datos + archivos; prueba de restauración mensual documentada.
- Cada job registra `JobRun` (inicio, fin, resultado, errores, reintentos) y es re-ejecutable sin duplicar efectos.
