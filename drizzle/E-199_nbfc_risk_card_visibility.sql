-- E-199 — Per-NBFC risk-card visibility allowlist.
--
-- The NBFC Risk dashboard (/nbfc/risk) previously rendered EVERY non-retired
-- risk hypothesis for a tenant. This table lets an iTarang admin curate, per
-- NBFC partner, exactly which cards that partner may see.
--
-- Semantics: STRICT ALLOWLIST. Presence of a (tenant_id, hypothesis_id) row =
-- "this card is visible for this tenant". No row = hidden. A tenant with zero
-- rows sees zero cards. There is intentionally NO seed — every partner starts
-- blank until an admin selects cards for them.
--
-- The filter is applied at DISPLAY time in loadCards(), so it automatically
-- survives every "Re-run analysis" (a re-run only writes risk_card_runs).
--
-- Additive + idempotent. Re-running this file is a no-op.

CREATE TABLE IF NOT EXISTS "nbfc_risk_card_visibility" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"     uuid NOT NULL REFERENCES "nbfc_tenants"("id") ON DELETE CASCADE,
  "hypothesis_id" uuid NOT NULL REFERENCES "risk_hypotheses"("id") ON DELETE CASCADE,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_by"    uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_risk_card_visibility_tenant_hyp_uidx"
  ON "nbfc_risk_card_visibility" ("tenant_id", "hypothesis_id");

CREATE INDEX IF NOT EXISTS "nbfc_risk_card_visibility_tenant_idx"
  ON "nbfc_risk_card_visibility" ("tenant_id");

COMMENT ON TABLE "nbfc_risk_card_visibility" IS
  'E-199 — strict allowlist of risk-hypothesis cards an admin has enabled for an NBFC tenant. Presence of a row = visible; absence = hidden. Filtered at display time in the NBFC Risk page.';
