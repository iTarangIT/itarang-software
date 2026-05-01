/**
 * E-090 — DPDPA 2023 consent record + withdrawal service.
 *
 * Reads the latest `consent_records` row for a lead and maintains the
 * `nbfc_consent_scopes` and `nbfc_consent_withdrawals` companion tables.
 *
 * Scope model (DPDPA §6.4.4 — "Consent Before Collection"):
 *   * loan_processing      — required to service the loan; survives withdrawal
 *   * risk_assessment      — telemetry-derived signals; deactivated on withdrawal
 *   * warranty_management  — telemetry-derived signals; deactivated on withdrawal
 *
 * Withdrawal preserves the consent_records row (DPDPA does not allow
 * retroactive erasure of past data, and existing loan obligations remain).
 * Subsequent risk-scoring jobs read nbfc_consent_withdrawals and exclude
 * telemetry-derived signals for the lead.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  consentRecords,
  nbfcConsentScopes,
  nbfcConsentWithdrawals,
} from "@/lib/db/schema";

export const DPDPA_SCOPE_KEYS = [
  "loan_processing",
  "risk_assessment",
  "warranty_management",
] as const;

export const TELEMETRY_SCOPE_KEYS = [
  "risk_assessment",
  "warranty_management",
] as const;

export const WITHDRAWAL_CHANNELS = [
  "grievance_portal",
  "helpline",
  "email",
] as const;

export type DpdpaScopeKey = (typeof DPDPA_SCOPE_KEYS)[number];
export type WithdrawalChannel = (typeof WITHDRAWAL_CHANNELS)[number];

export interface ConsentSnapshot {
  lead_id: string;
  consent_id: string;
  scopes: DpdpaScopeKey[];
  signed_at: string | null;
  status: "active" | "withdrawn";
  withdrawn_at: string | null;
  withdrawal_channel: WithdrawalChannel | null;
}

/**
 * Loads the latest consent_records row for a lead. Returns null if the lead
 * has no consent record yet (KYC Step 2 has not run).
 */
async function loadLatestConsent(lead_id: string) {
  const rows = await db
    .select()
    .from(consentRecords)
    .where(eq(consentRecords.lead_id, lead_id))
    .orderBy(desc(consentRecords.created_at))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ensures the three default DPDPA scopes exist (active=true) for a consent_id.
 * Idempotent — uses the (consent_id, scope_key) unique index.
 */
async function ensureDefaultScopes(consent_id: string): Promise<void> {
  const existing = await db
    .select({ scope_key: nbfcConsentScopes.scope_key })
    .from(nbfcConsentScopes)
    .where(eq(nbfcConsentScopes.consent_id, consent_id));
  const have = new Set(existing.map((r) => r.scope_key));
  const missing = DPDPA_SCOPE_KEYS.filter((k) => !have.has(k));
  if (missing.length === 0) return;
  await db.insert(nbfcConsentScopes).values(
    missing.map((k) => ({
      consent_id,
      scope_key: k,
      is_active: true,
    })),
  );
}

export async function getConsentSnapshot(
  lead_id: string,
): Promise<ConsentSnapshot | null> {
  const consent = await loadLatestConsent(lead_id);
  if (!consent) return null;

  await ensureDefaultScopes(consent.id);

  const scopes = await db
    .select()
    .from(nbfcConsentScopes)
    .where(eq(nbfcConsentScopes.consent_id, consent.id));

  const withdrawals = await db
    .select()
    .from(nbfcConsentWithdrawals)
    .where(eq(nbfcConsentWithdrawals.consent_id, consent.id))
    .orderBy(desc(nbfcConsentWithdrawals.withdrawn_at))
    .limit(1);

  const latestWithdrawal = withdrawals[0] ?? null;
  const activeScopes = scopes
    .filter((s) => s.is_active)
    .map((s) => s.scope_key as DpdpaScopeKey);
  const status: "active" | "withdrawn" = latestWithdrawal ? "withdrawn" : "active";

  return {
    lead_id,
    consent_id: consent.id,
    scopes: activeScopes,
    signed_at: consent.signed_at ? consent.signed_at.toISOString() : null,
    status,
    withdrawn_at: latestWithdrawal
      ? latestWithdrawal.withdrawn_at.toISOString()
      : null,
    withdrawal_channel: latestWithdrawal
      ? (latestWithdrawal.withdrawal_channel as WithdrawalChannel)
      : null,
  };
}

export interface WithdrawConsentInput {
  lead_id: string;
  withdrawal_channel: WithdrawalChannel;
  reason?: string;
  performed_by?: string;
}

export interface WithdrawConsentResult {
  lead_id: string;
  consent_id: string;
  status: "withdrawn";
  withdrawn_at: string;
  withdrawal_channel: WithdrawalChannel;
}

export async function withdrawConsent(
  input: WithdrawConsentInput,
): Promise<WithdrawConsentResult> {
  const consent = await loadLatestConsent(input.lead_id);
  if (!consent) {
    throw new Error("NOT_FOUND: no consent record for lead");
  }

  await ensureDefaultScopes(consent.id);

  // Insert withdrawal row (append-only).
  const inserted = await db
    .insert(nbfcConsentWithdrawals)
    .values({
      lead_id: input.lead_id,
      consent_id: consent.id,
      withdrawal_channel: input.withdrawal_channel,
      reason: input.reason ?? null,
    })
    .returning();
  const withdrawal = inserted[0];

  // Deactivate telemetry-derived scopes; loan_processing stays active because
  // existing loan obligations remain enforceable per DPDPA §6.4.4.
  await db
    .update(nbfcConsentScopes)
    .set({ is_active: false, deactivated_at: withdrawal.withdrawn_at })
    .where(
      and(
        eq(nbfcConsentScopes.consent_id, consent.id),
        inArray(nbfcConsentScopes.scope_key, [...TELEMETRY_SCOPE_KEYS]),
      ),
    );

  // Audit trail.
  await db.insert(auditLogs).values({
    id: randomUUID(),
    entity_type: "consent_records",
    entity_id: consent.id,
    action: "dpdpa.consent_withdrawn",
    performed_by: input.performed_by ?? null,
    new_data: {
      lead_id: input.lead_id,
      consent_id: consent.id,
      withdrawal_channel: input.withdrawal_channel,
      reason: input.reason ?? null,
      deactivated_scopes: [...TELEMETRY_SCOPE_KEYS],
    },
  });

  return {
    lead_id: input.lead_id,
    consent_id: consent.id,
    status: "withdrawn",
    withdrawn_at: withdrawal.withdrawn_at.toISOString(),
    withdrawal_channel: input.withdrawal_channel,
  };
}
