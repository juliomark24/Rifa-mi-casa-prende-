# Backup y restauración — PRENDE RIFAS

**Fuente:** plan v2.2 §2.8, §2.19 y §5.4; `docs/jobs.md` §4 (job `backup-daily`); prueba P10.

## Qué se respalda

- **Base de datos** completa (pedidos, boletos, pagos, ledger, comisiones, sorteos, tickets de soporte, auditoría).
- **Archivos** de `public/uploads/` (fotos de premios), si el directorio existe.
- Cada backup lleva un `manifest.json` con fecha, archivo, hash SHA256, tamaño, resultado de `PRAGMA integrity_check` y conteos de las tablas clave.

## Cómo corre (desarrollo / SQLite)

El job `backup-daily` (`src/jobs/backup.ts`, ejecutado vía `runJobByName("backup-daily")` o `runAllJobs()`) copia el archivo de `DATABASE_URL` a:

```
<BACKUP_DIR o ./backups>/<YYYY-MM-DD>/prende-rifas.db
<BACKUP_DIR o ./backups>/<YYYY-MM-DD>/manifest.json
```

Es idempotente por día: re-ejecutarlo el mismo día sobrescribe el backup de ese día (no crea dos cadenas). Cada backup se verifica antes de darse por bueno: el SHA256 de la copia debe ser idéntico al original y la copia debe pasar `PRAGMA integrity_check`. Un backup corrupto o incompleto hace fallar el job (`JobRun FAILED`) y dispara la alerta `backups_fallidos` (§2.19). Nunca se marca un día como "respaldado" sin backup verificado.

Retención: los directorios `backups/<fecha>` se conservan; el borrado de backups viejos es manual (o por el host) hasta que el panel lo configure. **Nunca se commitea un backup**: `*.db` y `backups/` están fuera del repo (ver `.gitignore`).

## Producción (PostgreSQL) — procedimiento del host

En producción la BD es PostgreSQL y el job `backup-daily` **no** genera un backup local: devuelve `mode: "host-managed", verified: false` y el monitoreo alerta si no hay backup verificado. El backup real se configura en el host:

```bash
# 1. Backup diario con pg_dump (cron del host, 03:00 hora RD, ejemplo):
0 3 * * * pg_dump -Fc "$DATABASE_URL" > /var/backups/prende-rifas/$(date +\%F).dump \
  && sha256sum /var/backups/prende-rifas/$(date +\%F).dump > /var/backups/prende-rifas/$(date +\%F).sha256

# 2. Archivos (uploads) con rsync al mismo destino:
0 3 * * * rsync -a /srv/prende-rifas/public/uploads/ /var/backups/prende-rifas/$(date +\%F)-uploads/
```

Para que el monitoreo lo vea como verificado, el proceso del host debe dejar un `manifest.json` junto al dump (fecha, archivo, sha256, tamaño) y registrar una ejecución `backup-daily` COMPLETED con `verified: true` (o el panel lo leerá del directorio de backups). Hasta que eso exista, la alerta `backups_fallidos` permanece activa — a propósito.

## Prueba de restauración (P10) — obligatoria y mensual

Restaurar el backup en un entorno limpio y verificar ventas, boletos, comisiones y saldos. Script:

```bash
# Contra el backup más reciente de ./backups, comparando con la BD de origen:
node scripts/restore-test.mjs

# Contra un backup concreto y una BD de origen concreta:
node scripts/restore-test.mjs --backup backups/2026-11-21 --source prisma/dev.db
```

Qué verifica el script (y qué significa cada fallo):

1. El archivo de backup existe.
2. Su hash SHA256 coincide con el `manifest.json`.
3. La copia restaurada en un directorio temporal pasa `PRAGMA integrity_check`.
4. Los agregados coinciden con la BD de origen: pedidos, boletos, boletos vendidos, pagos, pagos aprobados, comisiones (conteo y suma), asientos del ledger (conteo, suma de ventas, saldo total).
5. Integridad referencial: ningún boleto vendido ni comisión sin su pedido.

Sale con código 0 solo si todo es PASS. Cada prueba mensual deja acta: fecha, entorno, resultado y quién la hizo (guardar la salida del script junto al checklist de salida a producción, §5.4: "Backups restaurados exitosamente en prueba").

## Recuperación ante fallos (resumen operativo)

- **Cae el servidor:** reiniciar el servicio; los jobs huérfanos en `RUNNING` se marcan FAILED al arrancar (`recoverStaleJobRuns`) y la siguiente ejecución retoma el trabajo desde el estado en BD. Las compras confirmadas no se pierden (P9).
- **Se corrompe la BD:** detener la app, restaurar el último backup verificado con el script de arriba, verificar los agregados y volver a arrancar. Nunca restaurar un backup sin verificar (el script lo hace antes de darlo por bueno).
- **Cae el proveedor de pagos:** las ventas con transferencia manual siguen; los pagos con tarjeta quedan pendientes y se concilian cuando el proveedor vuelve (job `reconcile-provider`, §2.13). La alerta `pasarela_caida` avisa al admin.
