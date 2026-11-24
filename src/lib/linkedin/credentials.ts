/**
 * Provider keys for the LinkedIn module, stored in THIS environment's database
 * (sandbox keys on the sandbox DB, prod keys on the prod DB) and sealed with
 * secretBox (APP_SECRETS_ENC_KEY). An env var of the same meaning is the
 * fallback, so a server can be configured either way. The plain value never
 * leaves the server: the Accounts screen sees only `last4`.
 *
 * Keys this module does NOT store: the LLM (existing assistant config) and
 * Firecrawl (FIRECRAWL_API_KEY, used by the scraper) — the CRM already has them.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { lastChars, open, seal, secretBoxEnabled } from "@/lib/security/secretBox";

// Lazy: the providers import this file, and their pure helpers are unit-tested
// without a database.
async function store() {
  const [{ db }, { liProviderCredentials }] = await Promise.all([import("@/lib/db"), import("@/lib/db/schema-linkedin")]);
  return { db, liProviderCredentials };
}

export const CREDENTIAL_SLOTS = {
  "brightdata:api_token": { env: "BRIGHTDATA_API_TOKEN", label: "Bright Data API token" },
  "brightdata:dataset_id": { env: "BRIGHTDATA_DATASET_ID", label: "Bright Data people-profile dataset id" },
  "unipile:dsn": { env: "UNIPILE_DSN", label: "Unipile DSN (e.g. api8.unipile.com:13851)" },
  "unipile:api_key": { env: "UNIPILE_API_KEY", label: "Unipile API key" },
  "webhook:secret": { env: "LI_WEBHOOK_SECRET", label: "Webhook secret (generated)" },
} as const;
export type CredentialSlot = keyof typeof CREDENTIAL_SLOTS;

export function isCredentialSlot(s: string): s is CredentialSlot {
  return Object.prototype.hasOwnProperty.call(CREDENTIAL_SLOTS, s);
}

const aad = (slot: CredentialSlot) => `li:${slot}`;
const split = (slot: CredentialSlot) => slot.split(":") as [string, string];

const TTL_MS = 30_000;
const cache = new Map<CredentialSlot, { at: number; value: string | null }>();

export function invalidateCredentialCache(): void {
  cache.clear();
}

/** The plain value: DB first, then the env fallback. null = not configured. */
export async function getSecret(slot: CredentialSlot): Promise<string | null> {
  const hit = cache.get(slot);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: string | null = null;
  try {
    const { db, liProviderCredentials } = await store();
    const [provider, kind] = split(slot);
    const [row] = await db
      .select()
      .from(liProviderCredentials)
      .where(and(eq(liProviderCredentials.provider, provider), eq(liProviderCredentials.kind, kind)))
      .limit(1);
    if (row) value = open({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }, aad(slot));
  } catch (err) {
    // A DB without E-393 yet — fall through to the env.
    console.warn("[linkedin:credentials] read failed:", err instanceof Error ? err.message : err);
  }
  if (!value) value = process.env[CREDENTIAL_SLOTS[slot].env]?.trim() || null;
  cache.set(slot, { at: Date.now(), value });
  return value;
}

export async function saveSecret(slot: CredentialSlot, plain: string, actorId: string | null): Promise<{ last4: string }> {
  const value = plain.trim();
  if (!value) throw Object.assign(new Error("Value is empty"), { status: 400 });
  if (!secretBoxEnabled()) {
    throw Object.assign(
      new Error("This server has no APP_SECRETS_ENC_KEY, so keys cannot be stored in the database. Set it, or use the env var instead."),
      { status: 503 },
    );
  }
  const [provider, kind] = split(slot);
  const { db, liProviderCredentials } = await store();
  const sealed = seal(value, aad(slot));
  const last4 = lastChars(value);
  await db
    .insert(liProviderCredentials)
    .values({ provider, kind, ...sealed, last4, updated_by: actorId, updated_at: new Date() })
    .onConflictDoUpdate({
      target: [liProviderCredentials.provider, liProviderCredentials.kind],
      set: { ...sealed, last4, updated_by: actorId, updated_at: new Date() },
    });
  cache.delete(slot);
  return { last4 };
}

export async function deleteSecret(slot: CredentialSlot): Promise<void> {
  const [provider, kind] = split(slot);
  const { db, liProviderCredentials } = await store();
  await db
    .delete(liProviderCredentials)
    .where(and(eq(liProviderCredentials.provider, provider), eq(liProviderCredentials.kind, kind)));
  cache.delete(slot);
}

export type CredentialStatus = {
  slot: CredentialSlot;
  label: string;
  source: "db" | "env" | "none";
  last4: string | null;
  updated_at: string | null;
};

/** What the Accounts screen shows: where each key comes from and its last 4 — never the value. */
export async function credentialStatus(): Promise<{ encryption: boolean; items: CredentialStatus[] }> {
  const { db, liProviderCredentials } = await store();
  let rows: (typeof liProviderCredentials.$inferSelect)[] = [];
  try {
    rows = await db.select().from(liProviderCredentials);
  } catch {
    rows = [];
  }
  const items = (Object.keys(CREDENTIAL_SLOTS) as CredentialSlot[]).map((slot) => {
    const [provider, kind] = split(slot);
    const row = rows.find((r) => r.provider === provider && r.kind === kind);
    const env = process.env[CREDENTIAL_SLOTS[slot].env]?.trim();
    return {
      slot,
      label: CREDENTIAL_SLOTS[slot].label,
      source: row ? ("db" as const) : env ? ("env" as const) : ("none" as const),
      last4: row ? row.last4 : env ? lastChars(env) : null,
      updated_at: row ? row.updated_at.toISOString() : null,
    };
  });
  return { encryption: secretBoxEnabled(), items };
}

/**
 * The webhook secret this environment hands to Bright Data / Unipile. Minted
 * and stored on first use, so nobody has to invent one.
 */
export async function webhookSecret(): Promise<string | null> {
  const existing = await getSecret("webhook:secret");
  if (existing) return existing;
  if (!secretBoxEnabled()) return null;
  const minted = randomBytes(24).toString("base64url");
  await saveSecret("webhook:secret", minted, null);
  return minted;
}

/** Firecrawl key for profile discovery. SCRAPPER_API_KEY is LinkedIn's own
 *  Firecrawl key (so searches don't eat the scraper's credits); the scraper's
 *  FIRECRAWL_API_KEY is the fallback. */
export const FIRECRAWL_KEY_ENVS = ["SCRAPPER_API_KEY", "FIRECRAWL_API_KEY"] as const;
export function firecrawlKey(): string | null {
  for (const name of FIRECRAWL_KEY_ENVS) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return null;
}
