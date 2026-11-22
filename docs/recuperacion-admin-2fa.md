# Recuperación de cuentas admin y 2FA

**Fuente:** plan v2.2 §2.8 y aclaración 5 de ejecución (21 nov 2026) — "procedimiento diseñado, documentado y probado, sin mecanismos que permitan saltarse controles de seguridad".
**Contrato API:** `POST /api/auth/recover` (ver `API-CONTRACT-v2.2.md`).
**Alcance:** todos los roles administrativos (SUPERADMIN, ADMIN_RIFAS, FINANZAS, AUDITOR, MARKETING) con 2FA obligatorio. Los roles CLIENTE y AFILIADO usan el flujo normal de restablecimiento de contraseña y NO están cubiertos por este documento.

## Principios (no negociables)

1. **NINGÚN camino salta 2FA.** No existe "recuperación sin 2FA", ni bypass de emergencia, ni secreto maestro, ni enlace mágico que devuelva acceso admin sin verificación de segundo factor.
2. **Nunca auto-aprobación.** Quien solicita la recuperación nunca puede aprobarla. La aprueba OTRO SUPERADMIN con 2FA vigente.
3. **Todo queda en audit log.** Solicitud, aprobación/rechazo, entrega del código, uso del código, reseteo, revocación de sesiones, invalidación del TOTP y re-enrolamiento: cada paso con actor, fecha/hora y resultado.
4. **Ventanas cortas.** La solicitud expira en 1 hora; el código de un solo uso expira en 15 minutos. Pasado el plazo, el proceso entero vuelve a empezar.
5. **Recuperar no es restaurar el acceso tal cual.** Recuperar una cuenta admin significa: contraseña nueva + sesiones revocadas + secreto TOTP anterior invalidado + re-enrolamiento obligatorio de 2FA antes de cualquier acción admin.

## Modelo de datos (resumen)

`RecoveryRequest`: id, `userId`, `type` (`PASSWORD` | `TWO_FA` | `AMBOS`), `status` (`PENDIENTE` | `APROBADA` | `RECHAZADA` | `EXPIRADA` | `COMPLETADA`), `tokenHash` (hash del token de solicitud; nunca el token en claro), `requestedAt`, `expiresAt` (requestedAt + 1 h), `requestedIp`, `requestedUserAgent`, `reason` (texto libre del solicitante), `approvedByUserId` (nullable), `approvedAt` (nullable), `rejectedByUserId` / `rejectedReason` (nullable), `codeHash` (hash del código de un solo uso; nullable hasta la aprobación), `codeExpiresAt` (nullable), `codeUsedAt` (nullable), `completedAt` (nullable).

Reglas de integridad: una sola `RecoveryRequest` PENDIENTE por usuario a la vez (una segunda solicitud mientras hay una pendiente se rechaza con 409); `approvedByUserId ≠ userId` (constraint + verificación en código); el `tokenHash` y el `codeHash` se guardan con hash lento (bcrypt) y nunca se registran en logs.

## Flujo paso a paso

### Paso 1 — Solicitud (el admin bloqueado)

1. El admin sin acceso abre la página de recuperación e introduce su email y el motivo (ej. "perdí el teléfono con el autenticador").
2. El sistema responde **siempre igual**, exista o no la cuenta ("Si la cuenta existe y es administrativa, se registró una solicitud"): no se revela si el email existe.
3. Si la cuenta existe y es admin, se crea una `RecoveryRequest` en estado `PENDIENTE` con `tokenHash` y `expiresAt = ahora + 1 h`. Se registra en audit log (`RECOVERY_REQUESTED`, sin exponer el token).
4. Se notifica a **todos los SUPERADMIN activos** (email + panel admin: alerta "Solicitud de recuperación pendiente") con el nombre del solicitante y la hora límite. La notificación NO contiene el token ni el código.
5. **Rate limiting:** máximo 3 solicitudes por cuenta en 24 h y máximo 10 solicitudes por IP en 1 h. Superado el límite, 429. Cada intento (incluso bloqueado) queda en audit log.

### Paso 2 — Aprobación por OTRO SUPERADMIN con 2FA

1. Un SUPERADMIN distinto del solicitante abre la solicitud en el panel admin. El sistema verifica: su sesión es válida, su 2FA está activo y verificado en esta sesión, y su `userId ≠ userId` del solicitante. **Si el aprobador es el mismo solicitante, la acción se rechaza (403) y queda registrada como intento de auto-aprobación.**
2. El aprobador revisa el motivo, la IP y la hora de la solicitud, y la **aprueba o la rechaza** (con motivo obligatorio en caso de rechazo).
3. Al aprobar: estado `APROBADA`, `approvedByUserId` + `approvedAt`. Se genera el **código de un solo uso** (6 dígitos, aleatorio criptográfico), se guarda solo su `codeHash`, con `codeExpiresAt = ahora + 15 min`. Se registra en audit log (`RECOVERY_APPROVED`, actor = aprobador).
4. El código se envía **solo por el canal registrado** del solicitante (el email verificado de su cuenta; nunca a un email nuevo introducido en la solicitud). El código nunca aparece en el panel admin ni en ningún log.
5. Si la solicitud expira (1 h sin aprobación), pasa a `EXPIRADA` automáticamente (job o verificación al consultar) y hay que empezar de nuevo.

### Paso 3 — Uso del código (el solicitante)

1. El solicitante introduce el código en la página de recuperación junto con su email.
2. El sistema verifica: solicitud `APROBADA`, código no usado, `codeExpiresAt` vigente, y el hash coincide (comparación de tiempo constante / bcrypt). **Máximo 5 intentos fallidos por solicitud**; al quinto, la solicitud pasa a `RECHAZADA` (motivo: "demasiados intentos fallidos") y queda en audit log.
3. Código correcto → el sistema marca `codeUsedAt` (el código queda inutilizable: un solo uso) y entrega una **sesión de recuperación de un solo propósito**: un token de corta duración (10 min) que SOLO permite completar el paso 4. No permite ver el panel, ni operar, ni leer datos. Cualquier otro endpoint con ese token responde 403.

### Paso 4 — Restablecimiento y re-enrolamiento (con la sesión de recuperación)

1. **Nueva contraseña** (mínimo exigido por la política del sistema; nunca la anterior; hash bcrypt 12 rounds).
2. **Revocación de TODAS las sesiones** del usuario (tabla de sesiones: todas revocadas, incluida la sesión desde la que se pidió la recuperación si existiera). El usuario queda desconectado en todos los dispositivos.
3. **Invalidación del secreto TOTP anterior**: el secreto 2FA viejo se borra; los códigos de respaldo viejos quedan invalidados.
4. **Re-enrolamiento obligatorio de 2FA** antes de cualquier acción admin: el usuario debe completar el alta de TOTP (`POST /api/auth/2fa/setup` + `POST /api/auth/2fa/verify`) con un autenticador nuevo y guardar sus códigos de respaldo nuevos (mostrados una sola vez). **Hasta completar el re-enrolamiento, la cuenta queda en estado "2FA pendiente": puede iniciar sesión pero NO puede ejecutar ninguna acción administrativa** (cualquier endpoint admin responde 403 `2FA_REQUIRED`).
5. Al completar: solicitud `COMPLETADA` (`completedAt`), audit log (`RECOVERY_COMPLETED`, `PASSWORD_RESET`, `SESSIONS_REVOKED`, `TOTP_INVALIDATED`, `TWO_FA_REENROLLED`).

## Estados

```
PENDIENTE ──aprobación──▶ APROBADA ──código usado──▶ COMPLETADA
    │  (otro SUPERADMIN        (código 15 min,
    │   con 2FA)                1 solo uso)
    ├──rechazo──▶ RECHAZADA
    ├──expira 1 h──▶ EXPIRADA
    └──5 intentos fallidos──▶ RECHAZADA
APROBADA ──expira 15 min sin usar──▶ EXPIRADA (hay que solicitar de nuevo)
```

## Casos especiales

- **No queda ningún SUPERADMIN con acceso** (ej. el único superadmin pierde su 2FA y no hay otro que apruebe): NO existe bypass en la aplicación. La recuperación requiere intervención del dueño con acceso al servidor/hosting, siguiendo el procedimiento de emergencia documentado en el runbook de operaciones (acceso directo a base de datos por el dueño, con registro manual en auditoría). Este caso debe evitarse manteniendo **al menos 2 SUPERADMIN activos** con 2FA en todo momento (regla operativa; el panel alerta si queda un solo superadmin).
- **El solicitante también perdió el acceso a su email registrado:** el código no puede enviarse a otro canal. Se trata como caso de "ningún superadmin con acceso" (intervención del dueño, runbook). Nunca se cambia el email de contacto por teléfono o por palabra.
- **Códigos de respaldo:** si el admin conserva sus códigos de respaldo, puede entrar sin este flujo (un código de respaldo sustituye al TOTP en el login) y re-enrolar su 2FA desde su propia cuenta (`POST /api/auth/2fa/setup`). Los códigos de respaldo son de un solo uso y se invalidan al completar la recuperación.
- **Desactivar 2FA** (`POST /api/auth/2fa/disable`) requiere contraseña + código 2FA vigente y queda en auditoría; no es una vía de recuperación.

## Cómo se prueba

- **P-R1 (flujo completo):** solicitar → aprobar por otro superadmin con 2FA → código por email → restablecer → verificar: contraseña nueva funciona, sesiones viejas revocadas (401), TOTP viejo rechazado, 2FA pendiente bloquea endpoints admin (403 `2FA_REQUIRED`), tras re-enrolar el acceso admin vuelve.
- **P-R2 (auto-aprobación bloqueada):** el solicitante intenta aprobar su propia solicitud → 403 + entrada en audit log.
- **P-R3 (aprobador sin 2FA):** un superadmin sin 2FA vigente intenta aprobar → 403.
- **P-R4 (código expirado / reutilizado):** usar el código a los 16 min → rechazado; usar el mismo código dos veces → la segunda vez rechazado.
- **P-R5 (intentos fallidos):** 5 códigos erróneos → solicitud `RECHAZADA`.
- **P-R6 (solicitud expirada):** aprobar a los 61 min → rechazado, estado `EXPIRADA`.
- **P-R7 (rate limiting):** 4ª solicitud en 24 h → 429.
- **P-R8 (sin salto de 2FA):** con solo el token de solicitud (sin aprobación) no se puede restablecer nada; con la sesión de recuperación no se puede llamar a ningún endpoint admin ni de lectura de datos.
- **P-R9 (segunda solicitud pendiente):** solicitar dos veces seguidas → la segunda responde 409.

Relación con las pruebas del plan §5.1: estas pruebas se ejecutan en S2 y forman parte de P11 (acceso denegado donde corresponde). El reporte de S2 debe incluir la evidencia de P-R1–P-R9.
