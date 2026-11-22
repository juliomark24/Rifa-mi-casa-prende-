// Job `backup-daily` (plan §2.8, §2.19; docs/jobs.md §4).
// Backup diario de la base de datos + archivos, con verificación de
// integridad. Idempotente por día: re-ejecutarlo el mismo día reutiliza
// (sobrescribe) el backup de ese día, no crea dos cadenas.
//
// - SQLite (desarrollo/local): copia el archivo de DATABASE_URL a
//   <BACKUP_DIR|./backups>/<YYYY-MM-DD>/prende-rifas.db, verifica que
//   el hash SHA256 de la copia sea idéntico al original y que la copia
//   pase `PRAGMA integrity_check`, y escribe manifest.json con el
//   hash, el tamaño y los conteos de las tablas clave.
// - PostgreSQL (producción): el backup real se hace en el host con
//   pg_dump (ver docs/backup-restore.md). Este job NO inventa un
//   backup: devuelve mode "host-managed" con verified:false para que
//   el monitoreo alerte ("backups fallidos") si no hay backup verificado.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { db } from "../lib/db";
import type { JobHandler } from "../lib/jobs";

export const jobName = "backup-daily";

// better-sqlite3 no trae tipos propios: acceso vía require con un tipo mínimo.
const require = createRequire(import.meta.url);
type SqliteDb = {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
  close: () => void;
};
const Database = require("better-sqlite3") as new (
  file: string,
  opts?: { readonly?: boolean },
) => SqliteDb;

function sha256File(file: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function dateDir(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC; el día operativo es RD, ver doc)
}

export const handler: JobHandler = async () => {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.startsWith("file:")) {
    return {
      ok: true,
      mode: "host-managed",
      verified: false,
      reason:
        "PostgreSQL en producción: el backup real se configura en el host con pg_dump (ver docs/backup-restore.md). Este job no genera un backup local.",
    };
  }
  const source = path.resolve(process.cwd(), dbUrl.slice("file:".length));
  if (!fs.existsSync(source)) {
    throw new Error(`Base de datos SQLite no encontrada para el backup: ${source}`);
  }
  const now = new Date();
  const backupRoot = process.env.BACKUP_DIR ?? path.join(process.cwd(), "backups");
  const dir = path.join(backupRoot, dateDir(now));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "prende-rifas.db");

  // Si la BD está en modo WAL, volcar el WAL al archivo antes de copiar:
  // si no, la copia podría no incluir las escrituras más recientes.
  try {
    await db.$executeRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Modo journal delete (sin WAL): no hay nada que volcar.
  }
  fs.copyFileSync(source, dest);

  // Verificación de integridad: mismo hash + integrity_check + conteos.
  const sourceHash = sha256File(source);
  const destHash = sha256File(dest);
  if (sourceHash !== destHash) {
    fs.rmSync(dest, { force: true });
    throw new Error("El backup copiado no coincide con el original (hash SHA256 distinto)");
  }
  const copy = new Database(dest, { readonly: true });
  let integrity: unknown;
  let counts: Record<string, number> = {};
  try {
    integrity = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string })
      ?.integrity_check;
    const tables = ["Order", "Ticket", "Commission", "LedgerEntry", "Payment", "User"];
    for (const table of tables) {
      try {
        const row = copy.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
        counts[table] = row.c;
      } catch {
        counts[table] = -1; // tabla ausente en esta BD (no bloquea el backup)
      }
    }
  } finally {
    copy.close();
  }
  if (integrity !== "ok") {
    fs.rmSync(dest, { force: true });
    throw new Error(`El backup no pasa la comprobación de integridad: ${String(integrity)}`);
  }

  // Archivos (fotos de premios) si existen.
  const uploadsSrc = path.join(process.cwd(), "public", "uploads");
  let uploadsBackedUp = false;
  if (fs.existsSync(uploadsSrc)) {
    fs.cpSync(uploadsSrc, path.join(dir, "uploads"), { recursive: true });
    uploadsBackedUp = true;
  }

  const manifest = {
    date: dateDir(now),
    file: "prende-rifas.db",
    sha256: destHash,
    sizeBytes: fs.statSync(dest).size,
    verifiedAt: now.toISOString(),
    integrityCheck: "ok",
    counts,
    uploadsBackedUp,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { ok: true, mode: "sqlite", verified: true, dir, ...manifest };
};
