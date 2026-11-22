# Jobs del sistema (trabajos en segundo plano)

**Fuente:** plan v2.2 §1.2, §2.2, §2.11–§2.13, §2.16, §2.19 y aclaración 3 de ejecución — "todos los jobs programados deben resistir reinicios, duplicados, interrupciones y fallos parciales, con idempotencia, reintentos, registros y mecanismos de recuperación".
**Contrato API:** `API-CONTRACT-v2.2.md` (§ Jobs). Endpoints de monitoreo: `GET /api/admin/health`, `GET /api/admin/reconciliation`, `POST /api/admin/reconciliation/run`.

En MVP los jobs corren como **cron interno del mismo servidor** (Next.js); si el volumen lo exige, se mueven a cola dedicada (BullMQ + Redis) en Fase 2 — sin cambiar su contrato (idempotencia, `JobRun`, re-ejecutabilidad). **Un job nunca modifica dinero ni boletos en silencio**: cada ejecución, cada recuperación y cada discrepancia quedan registradas y visibles en el panel admin.

## Modelo común: `JobRun`

Cada ejecución de cada job registra una fila `JobRun`: `id`, `jobName`, `startedAt`, `finishedAt` (nullable mientras corre), `status` (`RUNNING` | `OK` | `PARTIAL` | `FAILED`), `itemsProcessed`, `itemsFailed`, `error` (último error, si lo hay), `retryOfJobRunId` (nullable; enlaza el reintento con la ejecución original), `details` (JSON con el resumen: ej. reservas liberadas, casos creados).

Reglas comunes a todos los jobs:

- **Idempotencia:** re-ejecutar un job (manual o automático) sobre el mismo trabajo no duplica efectos. Cada unidad de trabajo lleva su propia clave de idempotencia (ej. `reservationId`, `proveedor + ID de evento`, `notificationId`).
- **Reintentos con backoff:** un fallo transitorio (red, proveedor) se reintenta con espera creciente; un fallo persistente marca el ítem para revisión humana, no lo reintenta infinitamente.
- **Recuperación tras reinicio:** si el servidor se reinicia a mitad de una ejecución, el `JobRun` queda en `RUNNING` sin `finishedAt`; al arrancar, el sistema lo marca `FAILED` (interrumpido) y la siguiente ejecución programada retoma el trabajo pendiente desde donde quedó (el trabajo pendiente se detecta por estado en base de datos, no por memoria).
- **Ejecución solapada:** un job no se ejecuta dos veces a la vez. Si la ejecución anterior sigue `RUNNING` al llegar la siguiente hora programada, la nueva se salta y lo registra (`SKIPPED_OVERLAP` en el log del job).
- **Sin pérdida de compras confirmadas (P9):** los jobs solo leen/escriben base de datos transaccional; un reinicio no pierde compras confirmadas, reservas vigentes ni saldos.

## 1. `release-expired-reservations` — liberador de reservas (cada minuto)

**Qué hace:** libera las reservas de boletos vencidas (~10 min por defecto, `RESERVATION_MINUTES`) y devuelve los números a `disponible`.

**Garantías:**
- **Idempotente por `reservationId`:** la liberación es una transición de estado en transacción (`reservado → disponible` solo si la reserva sigue `reservada` y vencida). Ejecutarlo dos veces sobre la misma reserva no la libera dos veces ni crea dos registros: la segunda vez no encuentra nada que liberar.
- **Transaccional:** reserva + boletos se liberan en la misma transacción Prisma; si falla a mitad, no queda nada a medias.
- **Registro:** cada liberación queda registrada (reserva, boletos, hora de expiración, hora de liberación) y alimenta la métrica de reservas liberadas; el cliente recibe el aviso de reserva vencida vía el motor de notificaciones (no bloqueante).
- **Fallo parcial:** si una reserva no se puede liberar (ej. la rifa entró en sorteo congelado entre medias), esa reserva queda marcada para revisión y el job sigue con las demás; el `JobRun` queda `PARTIAL` con el detalle.
- **Recuperación:** una reserva vencida que el job no liberó (reinicio, caída) se libera en la siguiente ejecución (cada minuto): el criterio es el estado en base de datos, no una lista en memoria.
- **Alertas:** si hay reservas vencidas sin liberar durante más de 5 minutos, alerta en el panel (plan §2.19: "reservas que no se liberan").

**Pruebas relacionadas:** P5 (abandono de checkout = reserva liberada), P9 (reinicio sin pérdida).

## 2. `reconcile-provider` — conciliación diaria (+ bajo demanda)

**Qué hace:** compara, por proveedor y por período: pagos registrados en base de datos, pagos reportados por el proveedor, pedidos, boletos emitidos, reembolsos, contracargos y comisiones de procesamiento. Corre **a diario** (mínimo) y **bajo demanda** desde el panel (`POST /api/admin/reconciliation/run`).

**Garantías:**
- **No se confía solo en los webhooks** (plan §2.13): la conciliación consulta el estado al proveedor (API/reporte), no solo los eventos recibidos.
- **Toda diferencia genera alerta + caso de revisión** con su detalle (qué falta, en qué lado, montos, fechas). El caso se resuelve con acción registrada; **nunca se corrigen registros en silencio**.
- **Ejemplo:** pago confirmado por la pasarela pero sin boletos emitidos → caso de reconciliación; el cliente no se queda sin boleto: se emite el boleto o se reembolsa, con registro (ver también §2.12, caso de recuperación).
- **Idempotente:** una misma discrepancia no genera dos casos: el caso se identifica por (proveedor, referencia externa, tipo de discrepancia); si ya existe un caso abierto igual, se actualiza, no se duplica.
- **Re-ejecutable:** correr la conciliación dos veces sobre el mismo período da el mismo resultado (las discrepancias ya resueltas no reaparecen; las abiertas no se duplican).
- **Reporte:** reporte de conciliación por proveedor y por período, consultable en `GET /api/admin/reconciliation`.

**Pruebas relacionadas:** P21 (la conciliación detecta la discrepancia y genera alerta + caso sin alterar registros en silencio), P4 (webhook duplicado), P19 (pago confirmado sin boletos).

## 3. `notification-dispatch` — despacho de notificaciones (continuo)

**Qué hace:** procesa la cola de notificaciones (email / WhatsApp / SMS opcional / dentro de la web) para los eventos configurables del plan §2.16: compra iniciada, pago confirmado (boleto y comprobante), reserva por vencer, sorteo próximo, sorteo realizado, ganador, reembolso, comisión de afiliado, retiro de afiliado.

**Garantías:**
- **Cola con reintentos automáticos y backoff:** un envío fallido se reintenta (con espera creciente, hasta el máximo configurado); tras agotar reintentos queda `FALLIDO` con su error y genera alerta si el fallo es persistente.
- **Dedupe:** un evento genera **una** notificación por destinatario y canal, no varias. Clave de dedupe: (evento, destinatario, canal). Un reintento del job no reenvía una notificación ya enviada.
- **Registro de entregas:** cada notificación guarda su estado (`PENDIENTE` | `ENVIADO` | `ENTREGADO` | `FALLIDO`) con fecha y error si lo hay; consultable en `GET /api/admin/notifications`.
- **Nunca rompe la compra ni las operaciones financieras:** si WhatsApp o el correo fallan, la venta sigue y la notificación se reintenta en segundo plano (plan §2.16). El despacho corre desacoplado de la compra.
- **Plantillas por evento e idioma** según el país del cliente; preferencias de aviso del cliente respetadas donde la ley lo exija.

**Pruebas relacionadas:** P24 (notificación fallida no rompe la compra; se reintenta y el fallo queda registrado).

## 4. `backup-daily` — backup diario (+ prueba de restauración mensual)

**Qué hace:** copia de seguridad diaria de la base de datos + archivos (fotos de premios). Retención configurable. La **prueba de restauración mensual es obligatoria y documentada** (plan §2.8, §2.19, §5.4): restaurar el backup en un entorno limpio y verificar ventas, boletos, comisiones y saldos.

**Garantías:**
- **Verificación del backup:** cada backup registra tamaño, hash y resultado de una comprobación de integridad; un backup corrupto o incompleto genera alerta inmediata (no se descubre en el desastre).
- **Idempotente / sin duplicados:** un backup diario se identifica por fecha; re-ejecutarlo el mismo día reutiliza o reemplaza el backup de ese día, no crea dos cadenas distintas.
- **Recuperación:** si el backup falla (disco, red), queda `FAILED` en `JobRun`, se reintenta en la siguiente ventana y se alerta al admin (plan §2.19: "backups fallidos"). Nunca se marca un día como "respaldado" sin backup verificado.
- **Restauración documentada:** cada prueba mensual de restauración deja acta (fecha, entorno, resultado, quién la hizo) y alimenta el checklist de salida a producción (§5.4: "Backups restaurados exitosamente en prueba").

**Pruebas relacionadas:** P10 (backup restaurado = datos correctos), P9 (reinicio sin pérdida).

## 5. Jobs de soporte (mismo modelo `JobRun`)

| Job | Frecuencia | Función |
|---|---|---|
| `recovery-sweep` | cada 5 min | Detecta operaciones incompletas (pedido `PENDIENTE` sin confirmación, pago confirmado sin boletos emitidos, webhooks no entregados) y genera casos de recuperación (§2.12). Idempotente por pedido/pago; nunca duplica cobro, pedido, boletos ni comisiones al recuperar. |
| `expire-recovery-requests` | cada 5 min | Pasa a `EXPIRADA` las solicitudes de recuperación admin/2FA vencidas (1 h sin aprobación) y los códigos de un solo uso vencidos (15 min). Ver `docs/recuperacion-admin-2fa.md`. |
| `retention-sweep` | diario | Libera comisiones retenidas cuyo período de riesgo terminó (cierre de rifa o 7 días tras confirmación, lo que ocurra después) y las mueve a saldo disponible del afiliado. Idempotente por comisión; con asiento en ledger. |
| `fraud-scan` | continuo (por evento) | Alimenta el módulo de fraude (§2.14) con eventos de compra/pago/reserva/retiro; marca en `REVISIÓN` con motivo y regla. La decisión final es humana. |

## Monitoreo de jobs (plan §2.19)

- Panel de estado del sistema: cada job muestra última ejecución, resultado, duración, ítems procesados/fallidos y próximo horario (`GET /api/admin/health`).
- Alertas: job en `FAILED` dos veces seguidas, job sin ejecutar en su ventana, reservas vencidas sin liberar > 5 min, conciliación con casos abiertos > 24 h, backup fallido, notificaciones fallidas persistentes.
- Despliegue: staging separado de producción; despliegues controlados (staging → producción, con verificación) y rollback documentado y probado.
