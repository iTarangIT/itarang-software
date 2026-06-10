/**
 * Resolve + decrypt an NBFC's e-sign provider credentials (E-166).
 *
 * THE NON-BREAKING SEAM (mirrors src/lib/notifications/resolve-channel.ts):
 * a tenant with a vault row uses its OWN provider keys; with no row, `digio`
 * falls back to iTarang's GLOBAL Digio env account — i.e. exactly today's
 * behaviour. Any non-Digio provider requires a vault row (returns null otherwise).
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcProviderCredentials } from "@/lib/db/schema";
import { credentialAad, decryptJson } from "./crypto";
import type { EsignCreds, EsignEnvironment } from "./provider";
import { DIGIO_PRODUCTION_BASE_URL, getDigioBaseUrl, getDigioCreds } from "@/lib/digio/client";

export async function loadProviderCredentials(
  tenantId: string,
  providerType: string,
): Promise<EsignCreds | null> {
  const [row] = await db
    .select()
    .from(nbfcProviderCredentials)
    .where(
      and(
        eq(nbfcProviderCredentials.tenant_id, tenantId),
        eq(nbfcProviderCredentials.provider_type, providerType),
      ),
    )
    .limit(1);

  if (row) {
    const secrets = decryptJson(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version },
      credentialAad(tenantId, providerType),
    ) as Record<string, string>;
    return {
      providerId: providerType,
      source: "tenant",
      environment: (row.environment as EsignEnvironment) ?? "sandbox",
      secrets,
    };
  }

  // Global fallback — Digio only (iTarang's shared account). Non-Digio providers
  // have no global account, so a missing vault row means "not configured".
  if (providerType === "digio") {
    const creds = getDigioCreds();
    if (!creds) return null;
    const environment: EsignEnvironment =
      getDigioBaseUrl() === DIGIO_PRODUCTION_BASE_URL ? "production" : "sandbox";
    return {
      providerId: "digio",
      source: "global",
      environment,
      secrets: { clientId: creds.clientId, clientSecret: creds.clientSecret },
      baseUrl: getDigioBaseUrl(),
    };
  }
  return null;
}
