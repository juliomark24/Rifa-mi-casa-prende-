// Cifrado simétrico genérico (AES-256-GCM) para secretos guardados:
// secretos TOTP (ver totp.ts) y credenciales de pasarelas introducidas
// desde el panel (ver src/lib/payments/registry.ts).
// La clave sale de TOTP_ENCRYPTION_KEY (hex 32 bytes) o, en desarrollo,
// se deriva de JWT_SECRET. En producción TOTP_ENCRYPTION_KEY es obligatoria.
// Los valores cifrados NUNCA se devuelven por la API.
import crypto from "node:crypto";

export function encryptionKey(): Buffer {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, "hex");
    if (key.length !== 32) throw new Error("TOTP_ENCRYPTION_KEY debe ser hex de 32 bytes");
    return key;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("TOTP_ENCRYPTION_KEY es obligatorio en producción");
  }
  // Desarrollo/tests: derivada de JWT_SECRET (nunca en producción).
  return crypto.createHash("sha256").update(process.env.JWT_SECRET ?? "dev-only-totp-key").digest();
}

/** Formato: base64(iv) + "." + base64(ciphertext+tag). */
export function encryptText(plain: string): string {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${Buffer.concat([encrypted, tag]).toString("base64")}`;
}

export function decryptText(encrypted: string): string {
  const key = encryptionKey();
  const [ivB64, dataB64] = encrypted.split(".");
  if (!ivB64 || !dataB64) throw new Error("Texto cifrado corrupto");
  const iv = Buffer.from(ivB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const decrypted = Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** SHA-256 hex (tokens, códigos, jti de sesión). */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}
