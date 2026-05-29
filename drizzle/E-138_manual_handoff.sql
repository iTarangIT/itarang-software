-- E-138 — BRD Addendum V0.2 §11.7 (Manual Handoff — Model M2).
-- Routes a lead to NBFC(s) NOT operating inside the iTarang CRM. Email-based:
-- admin enters NBFC email IDs; each NBFC gets the customer KYC document. It is
-- competitive — more than one may be sent and may approve. Status is Sent →
-- Outcome only (MH-3, no intermediate status). A 24-hour recurring reminder
-- nudges the admin until an outcome is recorded or the admin declares it
-- exhausted (MH-4). On acceptance the lead re-enters for disbursement + Step 5.
--
-- Strictly additive + idempotent. One row per lead.

CREATE TABLE IF NOT EXISTS "manual_handoffs" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id"              varchar(50) NOT NULL,
  "tenant_id"           uuid,                  -- nullable: off-platform NBFCs aren't tenants
  "status"               varchar(24) NOT NULL DEFAULT 'sent',
  "sent_to_emails"       jsonb NOT NULL,        -- [{ email, nbfc_name? }]
  "sent_by"              uuid,
  "sent_at"              timestamptz NOT NULL DEFAULT now(),
  "last_nudge_at"        timestamptz,
  "nudge_count"          integer NOT NULL DEFAULT 0,
  "outcome"              text,
  "winning_nbfc_name"    varchar(200),
  "declining_nbfcs"      jsonb,
  "outcome_recorded_by"  uuid,
  "outcome_recorded_at"  timestamptz,
  "agreement_doc_url"    text,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "manual_handoffs_lead_unique"
  ON "manual_handoffs" ("lead_id");
-- Drives the 24-hour nudge cron sweep.
CREATE INDEX IF NOT EXISTS "manual_handoffs_status_nudge_idx"
  ON "manual_handoffs" ("status", "last_nudge_at")
  WHERE "status" = 'sent';

DO $do$ BEGIN
  ALTER TABLE "manual_handoffs"
    ADD CONSTRAINT "manual_handoffs_status_check"
    CHECK ("status" IN ('sent', 'outcome_accepted', 'outcome_declined', 'exhausted'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: manual_handoffs_status_check exists';
END; $do$;

COMMENT ON TABLE "manual_handoffs" IS
  'Addendum V0.2 §11.7 — Manual Handoff Model M2. Email-based, competitive, Sent→Outcome only; 24h recurring admin nudge until outcome or exhausted.';
