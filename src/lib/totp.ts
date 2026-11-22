// TOTP (RFC 6238) + códigos de respaldo + cifrado del secreto.
// Implementación propia con node:crypto (sin dependencia extra): HMAC-SHA1,
// paso de 30 s, ventana ±1 paso. El secreto se guarda cifrado con
// AES-256-GCM (ver src/lib/crypto.ts); los códigos de respaldo se
// hashean con bcrypt (nunca en claro).
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { decryptText, encryptText, hashToken, randomToken } from "./crypto";

export { decryptText as decryptSecret, encryptText as encryptSecret, hashToken, randomToken };

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;

// ---------------------------------------------------------------- base32
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Secreto TOTP inválido (base32)");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------- secreto
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20)); // 160 bits, estándar TOTP
}

export function totpAuthUrl(secret: string, accountName: string, issuer = "Prende Rifas"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  return (
    `otpauth://totp/${label}?secret=${secret}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** Verifica un código TOTP con ventana ±1 paso (tolerancia de reloj). */
export function verifyTotp(secret: string, code: string, nowMs = Date.now()): boolean {
  const clean = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (let i = -WINDOW; i <= WINDOW; i++) {
    const expected = hotp(secret, step + i);
    const a = Buffer.from(expected);
    const b = Buffer.from(clean);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Genera el código vigente (solo para tests; nunca exponer en producción). */
export function generateTotpCode(secret: string, nowMs = Date.now()): string {
  return hotp(secret, Math.floor(nowMs / 1000 / STEP_SECONDS));
}

// ---------------------------------------------------------------- códigos de respaldo
export function generateBackupCodes(count = 8): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase(); // 10 hex
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  const hashes = codes.map((c) => bcrypt.hashSync(c, 12));
  return { codes, hashes };
}

/**
 * Verifica un código de respaldo contra los hashes guardados.
 * Devuelve los hashes restantes (con el usado eliminado) o null si no coincide.
 * Cada código es de un solo uso.
 */
export async function consumeBackupCode(
  hashes: string[],
  code: string,
): Promise<string[] | null> {
  const clean = code.trim().toUpperCase();
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(clean, hashes[i])) {
      return hashes.filter((_, idx) => idx !== i);
    }
  }
  return null;
}

/** Código numérico de un solo uso (recuperación): 6 dígitos. */
export function generateNumericCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}
