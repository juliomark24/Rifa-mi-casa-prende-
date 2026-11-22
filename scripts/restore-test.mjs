// Prueba de restauración (P10; plan §2.8, §2.19, §5.4).
// Restaura el backup en una BD temporal limpia y verifica que ventas,
// boletos, comisiones y saldos coinciden con la BD de origen.
//
// Uso:
//   node scripts/restore-test.mjs --backup <dir|archivo> [--source <db>]
//   --backup: directorio del backup (con prende-rifas.db + manifest.json)
//             o el archivo .db directamente. Sin --backup usa el backup
//             más reciente de ./backups.
//   --source: BD de origen contra la que comparar (por defecto
//             DATABASE_URL si es file:, o ./prisma/dev.db).
//
// Verifica: hash SHA256 contra el manifest, PRAGMA integrity_check,
// conteos de Order/Ticket (VENDIDO)/Commission/LedgerEntry/Payment y
// sumas (ventas del ledger, comisiones). Imprime PASS/FAIL por chequeo
// y sale 0 solo si todo coincide. No toca la BD de origen (solo lectura)
// y borra el directorio temporal al final (salvo --keep-tmp).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function latestBackupDir(root) {
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null;
}

function aggregates(db) {
  const one = (sql) => {
    try {
      return db.prepare(sql).get();
    } catch {
      return null;
    }
  };
  return {
    orders: one("SELECT COUNT(*) AS c FROM \"Order\"")?.c ?? -1,
    tickets: one("SELECT COUNT(*) AS c FROM \"Ticket\"")?.c ?? -1,
    ticketsSold: one("SELECT COUNT(*) AS c FROM \"Ticket\" WHERE status = 'VENDIDO'")?.c ?? -1,
    payments: one("SELECT COUNT(*) AS c FROM \"Payment\"")?.c ?? -1,
    paymentsApproved: one("SELECT COUNT(*) AS c FROM \"Payment\" WHERE status = 'APROBADO'")?.c ?? -1,
    commissions: one("SELECT COUNT(*) AS c FROM \"Commission\"")?.c ?? -1,
    commissionSum: one("SELECT COALESCE(SUM(amount), 0) AS s FROM \"Commission\"")?.s ?? -1,
    ledgerEntries: one("SELECT COUNT(*) AS c FROM \"LedgerEntry\"")?.c ?? -1,
    ledgerSalesSum:
      one("SELECT COALESCE(SUM(amount), 0) AS s FROM \"LedgerEntry\" WHERE type = 'VENTA'")?.s ?? -1,
    ledgerBalance: one("SELECT COALESCE(SUM(amount), 0) AS s FROM \"LedgerEntry\"")?.s ?? -1,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // 1. Localizar el backup.
  let backupFile;
  let manifest = null;
  const backupArg = args.backup;
  if (backupArg) {
    const p = path.resolve(root, backupArg);
    if (fs.statSync(p).isDirectory()) {
      backupFile = path.join(p, "prende-rifas.db");
      const mf = path.join(p, "manifest.json");
      if (fs.existsSync(mf)) manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
    } else {
      backupFile = p;
    }
  } else {
    const dir = latestBackupDir(path.join(root, "backups"));
    if (!dir) {
      console.log("FAIL  backup no encontrado: no hay --backup ni ./backups/<fecha>");
      process.exit(1);
    }
    backupFile = path.join(dir, "prende-rifas.db");
    const mf = path.join(dir, "manifest.json");
    if (fs.existsSync(mf)) manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
  }
  if (!fs.existsSync(backupFile)) {
    console.log(`FAIL  archivo de backup no existe: ${backupFile}`);
    process.exit(1);
  }
  check("backup existe", true, backupFile);

  // 2. Hash contra el manifest (si lo hay).
  if (manifest?.sha256) {
    check("hash SHA256 coincide con manifest", sha256File(backupFile) === manifest.sha256);
  } else {
    console.log("SKIP  sin manifest.json: no se verifica el hash");
  }

  // 3. Restaurar en un directorio temporal limpio.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prende-restore-test-"));
  const restoredFile = path.join(tmp, "restored.db");
  try {
    fs.copyFileSync(backupFile, restoredFile);
    check("copia a entorno limpio", true, tmp);

    const restored = new Database(restoredFile, { readonly: true });
    const integrity = restored.prepare("PRAGMA integrity_check").get()?.integrity_check;
    check("integridad de la copia restaurada", integrity === "ok", String(integrity));
    const restoredAgg = aggregates(restored);

    // 4. Comparar contra la BD de origen (solo lectura).
    const sourceArg = args.source;
    let sourceFile = null;
    if (sourceArg) sourceFile = path.resolve(root, sourceArg);
    else if (process.env.DATABASE_URL?.startsWith("file:")) {
      sourceFile = path.resolve(root, process.env.DATABASE_URL.slice("file:".length));
    } else if (fs.existsSync(path.join(root, "prisma", "dev.db"))) {
      sourceFile = path.join(root, "prisma", "dev.db");
    }
    if (!sourceFile || !fs.existsSync(sourceFile)) {
      console.log("SKIP  sin BD de origen para comparar (usa --source <db>)");
      console.log("Agregados restaurados:", JSON.stringify(restoredAgg));
    } else {
      const source = new Database(sourceFile, { readonly: true });
      const sourceAgg = aggregates(source);
      source.close();
      for (const key of Object.keys(sourceAgg)) {
        check(
          `restaurado == origen: ${key}`,
          restoredAgg[key] === sourceAgg[key],
          `origen=${sourceAgg[key]} restaurado=${restoredAgg[key]}`,
        );
      }
      // 5. Integridad referencial puntual: cada boleto vendido tiene pedido.
      const orphanSold = restored
        .prepare(
          "SELECT COUNT(*) AS c FROM \"Ticket\" t WHERE t.status = 'VENDIDO' AND t.orderId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM \"Order\" o WHERE o.id = t.orderId)",
        )
        .get()?.c;
      check("boletos vendidos sin pedido huérfano", orphanSold === 0, `huérfanos=${orphanSold}`);
      const orphanCommissions = restored
        .prepare(
          "SELECT COUNT(*) AS c FROM \"Commission\" c WHERE NOT EXISTS (SELECT 1 FROM \"Order\" o WHERE o.id = c.orderId)",
        )
        .get()?.c;
      check("comisiones sin pedido huérfano", orphanCommissions === 0, `huérfanas=${orphanCommissions}`);
    }
    restored.close();
  } finally {
    if (!args["keep-tmp"]) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`Temporal conservado en ${tmp}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} chequeos PASS`);
  process.exit(failed.length ? 1 : 0);
}

main();
