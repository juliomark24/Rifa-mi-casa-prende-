// Setup de tests: apunta a la SQLite de test ANTES de importar src/lib/db.
// El `npm test` crea prisma/test.db con `prisma db push` antes de vitest.
// Si DATABASE_URL ya viene definida (ej. una subfase con su propia BD de
// test, file:./test-s3.db), se respeta y NO se sobrescribe.
process.env.DATABASE_URL ??= "file:./prisma/test.db";
process.env.JWT_SECRET = "test-jwt-secret-min-32-chars-long!!!";
process.env.TOTP_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.COMMISSION_RATE = "10";
