// Prisma singleton. Prisma 7 exige driver adapter en el constructor:
//  - SQLite (desarrollo): better-sqlite3 — DATABASE_URL=file:./dev.db
//  - PostgreSQL (producción): pg Pool — DATABASE_URL=postgresql://...
// La URL se pasa tal cual al adaptador (sin path.resolve ni process.cwd(),
// para no provocar el warning de Turbopack por acceso dinámico al
// filesystem en módulos importados por Route Handlers): el adaptador
// resuelve la ruta relativa respecto al cwd del proceso.
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Prisma, PrismaClient } from "../generated/prisma/client";

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL no está definida");
  if (url.startsWith("file:")) {
    return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new Pool({ connectionString: url });
    return new PrismaClient({ adapter: new PrismaPg(pool) });
  }
  throw new Error(`DATABASE_URL con esquema no soportado: ${url.split(":")[0]}:`);
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export type { PrismaClient };
/** Cliente transaccional (para usar dentro de db.$transaction). */
export type Tx = Prisma.TransactionClient;
