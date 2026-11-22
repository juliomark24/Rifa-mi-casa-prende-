// Prisma 7: la URL de conexión vive aquí, no en el schema.
// Desarrollo: SQLite (DATABASE_URL=file:./dev.db).
// Producción: PostgreSQL — cambiar el provider del schema a "postgresql"
// y DATABASE_URL a la URL de Postgres.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
