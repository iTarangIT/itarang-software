/**
 * AES-256-GCM credential encryption for the NBFC provider vault (E-166).
 *
 * App-held master key in env (`NBFC_CREDENTIALS_ENC_KEY`, base64 of 32 bytes).
 * Authenticated encryption: a random 12-byte IV per row, a 16-byte auth tag,
 * and an AAD bound to `tenantId:providerType` so a leaked ciphertext cannot be
 * replayed under a different tenant/provider. No new dependencies (node:crypto,
 * same idiom as src/lib/nbfc/handoff.ts).
 *
 * Key rotation: bump the env to a new key and move the old one to
 * `NBFC_CREDENTIALS_ENC_KEY_PREVIOUS`; decrypt tries current then previous.
 * A one-off re-encrypt script can then lift every row's key_version.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CURRENT_KEY_VERSION = 1;

function loadKey(which: "current" | "previous"): Buffer | null {
  const raw = which === "current"
    ? process.env.NBFC_CREDENTIALS_ENC_KEY
    : process.env.NBFC_CREDENTIALS_ENC_KEY_PREVIOUS;
  if (!raw || !raw.trim()) return null;
  const buf = Buffer.from(raw.trim(), "base64");
  if (buf.length !== 32) {
    throw new Error(
      `NBFC_CREDENTIALS_ENC_KEY${which === "previous" ? "_PREVIOUS" : ""} must be base64 of exactly 32 bytes (got ${buf.length})`,
    );
  }
  return buf;
}

/** True when the vault is usable (a valid current key is configured). */
export function isVaultEnabled(): boolean {
  try {
    return loadKey("current") !== null;
  } catch {
    return false;
  }
}

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string; // base64 (12 bytes)
  authTag: string; // base64 (16 bytes)
  keyVersion: number;
}

export function encryptJson(obj: unknown, aad: string): EncryptedBlob {
  const key = loadKey("current");
  if (!key) {
    throw new Error("NBFC_CREDENTIALS_ENC_KEY is not set — the credential vault is disabled");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decryptJson(blob: EncryptedBlob, aad: string): unknown {
  const attempt = (key: Buffer | null): unknown | undefined => {
    if (!key) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(blob.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(blob.ciphertext, "base64")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      return undefined; // wrong key / tampered → try the next
    }
  };
  const withCurrent = attempt(loadKey("current"));
  if (withCurrent !== undefined) return withCurrent;
  const withPrevious = attempt(loadKey("previous"));
  if (withPrevious !== undefined) return withPrevious;
  throw new Error("Failed to decrypt provider credentials (key mismatch or tampered ciphertext)");
}

/** AAD binds ciphertext to its row identity. */
export function credentialAad(tenantId: string, providerType: string): string {
  return `nbfc_provider_credentials:${tenantId}:${providerType}`;
}
