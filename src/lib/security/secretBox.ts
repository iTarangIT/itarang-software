/**
 * Small AES-256-GCM box for secrets the app stores in its own database
 * (A32: NeoDove campaign endpoint URLs, where the URL itself is the
 * credential). Same idiom as the NBFC vault (src/lib/nbfc/esign/crypto.ts):
 * a random 12-byte IV per value, a 16-byte auth tag, and an AAD that binds a
 * ciphertext to the row it belongs to, so it cannot be copied onto another.
 *
 * Key: APP_SECRETS_ENC_KEY (base64 of 32 bytes), else NBFC_CREDENTIALS_ENC_KEY,
 * so a server with the vault key needs nothing new. Generate one with
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Pure apart from reading the env: unit-tested in __tests__/secretBox.test.ts.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SealedSecret = { ciphertext: string; iv: string; tag: string };

const KEY_ENVS = ["APP_SECRETS_ENC_KEY", "NBFC_CREDENTIALS_ENC_KEY"] as const;

function key(): Buffer | null {
    for (const name of KEY_ENVS) {
        const raw = process.env[name]?.trim();
        if (!raw) continue;
        const buf = Buffer.from(raw, "base64");
        if (buf.length !== 32) throw new Error(`${name} must be base64 of exactly 32 bytes (got ${buf.length})`);
        return buf;
    }
    return null;
}

/** True when a key is configured, so secrets can be stored on this server. */
export function secretBoxEnabled(): boolean {
    try {
        return key() !== null;
    } catch {
        return false;
    }
}

export function seal(plain: string, aad: string): SealedSecret {
    const k = key();
    if (!k) throw new Error("No encryption key: set APP_SECRETS_ENC_KEY (base64 of 32 bytes) on this server.");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", k, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

/** The plain text, or null when the key is missing, wrong, or the value was tampered with or moved. */
export function open(sealed: SealedSecret, aad: string): string | null {
    const k = key();
    if (!k) return null;
    try {
        const d = createDecipheriv("aes-256-gcm", k, Buffer.from(sealed.iv, "base64"));
        d.setAAD(Buffer.from(aad, "utf8"));
        d.setAuthTag(Buffer.from(sealed.tag, "base64"));
        return Buffer.concat([d.update(Buffer.from(sealed.ciphertext, "base64")), d.final()]).toString("utf8");
    } catch {
        return null;
    }
}

/** The last few characters, for showing which value is stored without showing it. */
export function lastChars(plain: string, n = 4): string {
    return plain.length <= n ? "•".repeat(plain.length) : plain.slice(-n);
}
