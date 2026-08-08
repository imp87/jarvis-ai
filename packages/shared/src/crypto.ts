import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Envelope format (single string, safe for a Postgres `text` column):
 *   v1.<base64url iv>.<base64url authTag>.<base64url ciphertext>
 * The version prefix lets us rotate the scheme later without guessing.
 */
const VERSION = "v1";

export function parseMasterKey(hex: string): Buffer {
  const key = Buffer.from(hex.trim(), "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MASTER_KEY must be ${KEY_BYTES} bytes hex (${KEY_BYTES * 2} characters), got ${key.length} bytes`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(envelope: string, key: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("malformed secret envelope");
  }
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const ciphertext = Buffer.from(parts[3]!, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("malformed secret envelope");
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Constant-time comparison — use for every shared-secret check. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length isn't leaked by timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}
