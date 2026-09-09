-- =============================================================================
-- E-292 — Refurbish Flow v3: recovery triage, proforma invoice, offline money,
--         refurbisher partner login, final cost + margin, redeploy / auction
--         close. Rebuilds the E-270/E-271 lot engine to the review-meet design
--         (refurbish-flow-v3.html, 2026-09-08).
-- =============================================================================
-- WHAT CHANGED (see the `refurbish-flow` skill, "v3" section):
--
--   1 recovery triage        → rated / measured voltage + health % on the
--                              battery; the system SUGGESTS fit-as-is /
--                              refurbish / scrap, the NBFC CHOOSES
--   2 commercials            → negotiate → admin uploads a PI (PDF) → NBFC
--                              accepts the PI. Both PI ₹ and acceptance stored
--   3 money                  → paid OFFLINE into iTarang's bank; NBFC records
--                              the UTR, admin marks "amount received". The
--                              Razorpay order/payment columns stay (additive
--                              policy) but nothing writes them any more
--   4 who does the work      → an onboarded REFURBISHER partner with its own
--                              login (new `refurbishers` table +
--                              users.refurbisher_id, role 'refurbisher')
--   5 cost control           → the v2 "actual vs approved quote" revision loop
--                              is DROPPED: refurbisher final cost + iTarang
--                              margin = final bill, no NBFC re-approval
--   6 after return           → NBFC chooses redeploy | auction; lot `closed`
--
-- Additive and idempotent. Vocabulary lives in TypeScript (no CHECK).
--
-- Lot status vocabulary after this migration (20):
--   requested | reviewed | estimated | countered | agreed | pi_sent |
--   pi_accepted | advance_recorded | in_transit_out | received |
--   at_refurbisher | in_progress | costed | ready | in_transit_return |
--   delivered_back | balance_due | settled | closed | cancelled
-- Removed v2 statuses (remapped by the UPDATEs below):
--   proposed → estimated · awaiting_advance → pi_accepted ·
--   advance_paid → advance_recorded · pickup_scheduled → advance_recorded |
--   pi_accepted (by advance_status) · delivered → in_transit_out ·
--   revision_pending → in_progress
-- Job status vocabulary: requested | declined | at_refurbisher | ready |
--   returned | cancelled  (+ in_progress kept for legacy E-233 non-lot jobs)
-- Party vocabulary (lots.last_party, lots.cancelled_by_party, events.party):
--   nbfc | admin | refurbisher | system  — the three columns were varchar(8)
--   and 'refurbisher' is 11 chars, so they are WIDENED here.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Recovery triage — on the battery master
-- ---------------------------------------------------------------------------
DO $do$ BEGIN
  ALTER TABLE recovery_batteries
    ADD COLUMN IF NOT EXISTS rated_voltage_v     numeric(6,2),
    ADD COLUMN IF NOT EXISTS measured_voltage_v  numeric(6,2),
    ADD COLUMN IF NOT EXISTS health_pct          numeric(5,2),
    ADD COLUMN IF NOT EXISTS triage_condition    varchar(16),   -- good | fair | poor
    ADD COLUMN IF NOT EXISTS triage_note         text,
    ADD COLUMN IF NOT EXISTS triage_suggestion   varchar(16),   -- fit_as_is | refurbish | scrap
    ADD COLUMN IF NOT EXISTS triage_choice       varchar(16),   -- auction | redeploy | refurbish | scrap
    ADD COLUMN IF NOT EXISTS triaged_at          timestamptz,
    ADD COLUMN IF NOT EXISTS triaged_by          uuid;
  COMMENT ON COLUMN recovery_batteries.health_pct IS
    'E-292: measured_voltage_v / rated_voltage_v x 100, rounded to 0.1. The triage figure; falls back as the SOH when no evaluation exists.';
  COMMENT ON COLUMN recovery_batteries.triage_suggestion IS
    'E-292: what the system suggested from health_pct - fit_as_is (>= 78.4%) | refurbish (>= 70%) | scrap. Advisory only.';
  COMMENT ON COLUMN recovery_batteries.triage_choice IS
    'E-292: what the NBFC clicked - auction | redeploy | refurbish | scrap. Refurbish is refused below 70%.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip E-292 s1: recovery_batteries does not exist here';
END; $do$;

-- ---------------------------------------------------------------------------
-- 2. The refurbisher partner directory + its portal credentials
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refurbishers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        varchar(160) NOT NULL,
  contact_name                varchar(120),
  email                       varchar(200) NOT NULL,
  phone                       varchar(20),
  address                     text,
  city                        varchar(120),
  state                       varchar(120),
  gstin                       varchar(20),
  notes                       text,
  is_active                   boolean NOT NULL DEFAULT true,
  -- pending | dispatched | credential_dispatch_failed — latest attempt
  credential_dispatch_status  varchar(32),
  credential_dispatched_at    timestamptz,
  credential_last_error       text,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS refurbishers_email_uidx ON refurbishers (lower(email));
COMMENT ON TABLE refurbishers IS
  'E-292: onboarded refurbishment partners (the P Camp model). One login each via users.refurbisher_id + role refurbisher.';

-- One row per dispatch ATTEMPT, no password column (nbfc_portal_credentials /
-- vendor_portal_credentials shape).
CREATE TABLE IF NOT EXISTS refurbisher_portal_credentials (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refurbisher_id       uuid NOT NULL REFERENCES refurbishers(id) ON DELETE CASCADE,
  supabase_user_id     uuid NOT NULL,
  email                varchar(200) NOT NULL,
  dispatch_status      varchar(32) NOT NULL,   -- pending | dispatched | credential_dispatch_failed
  last_error           text,
  email_dispatched_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refurbisher_portal_credentials_ref_idx
  ON refurbisher_portal_credentials (refurbisher_id, created_at);

-- users.refurbisher_id — the E-195 pattern (users.role is a bare varchar, so
-- the 'refurbisher' role needs no DDL; it is registered in the TypeScript role
-- lists — middleware, sidebar, login redirects, lib/roles.ts, notifications).
DO $do$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS refurbisher_id uuid;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_refurbisher_id_fkey') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_refurbisher_id_fkey
      FOREIGN KEY (refurbisher_id) REFERENCES refurbishers(id);
  END IF;
  CREATE INDEX IF NOT EXISTS users_refurbisher_id_idx
    ON users (refurbisher_id) WHERE refurbisher_id IS NOT NULL;
  COMMENT ON COLUMN users.refurbisher_id IS
    'E-292 - refurbishers.id this login acts for; NULL for every non-refurbisher user. Pairs with role = refurbisher.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip E-292 s2 users: users does not exist here';
END; $do$;

-- ---------------------------------------------------------------------------
-- 3. Lots — PI, counter, refurbisher, margin, close; widen the party columns
-- ---------------------------------------------------------------------------
DO $do$ BEGIN
  ALTER TABLE refurbishment_lots
    -- party columns: 'refurbisher' is 11 chars
    ALTER COLUMN last_party         TYPE varchar(16),
    ALTER COLUMN cancelled_by_party TYPE varchar(16),
    -- 2: review + estimate
    ADD COLUMN IF NOT EXISTS reviewed_at            timestamptz,
    ADD COLUMN IF NOT EXISTS reviewed_by            uuid,
    -- 4: the NBFC's counter (cost / timeline / advance %)
    ADD COLUMN IF NOT EXISTS counter_total          numeric(14,2),
    ADD COLUMN IF NOT EXISTS counter_advance_pct    numeric(5,2),
    ADD COLUMN IF NOT EXISTS counter_receipt_date   date,
    ADD COLUMN IF NOT EXISTS counter_return_date    date,
    ADD COLUMN IF NOT EXISTS counter_message        text,
    -- 5/6: the proforma invoice
    ADD COLUMN IF NOT EXISTS pi_number              varchar(64),
    ADD COLUMN IF NOT EXISTS pi_url                 text,
    ADD COLUMN IF NOT EXISTS pi_amount              numeric(14,2),
    ADD COLUMN IF NOT EXISTS pi_advance_pct         numeric(5,2),
    ADD COLUMN IF NOT EXISTS pi_advance_amount      numeric(14,2),
    ADD COLUMN IF NOT EXISTS pi_bank_details        jsonb,          -- {account_name, account_number, ifsc, bank_name, upi}
    ADD COLUMN IF NOT EXISTS pi_note                text,
    ADD COLUMN IF NOT EXISTS pi_sent_at             timestamptz,
    ADD COLUMN IF NOT EXISTS pi_sent_by             uuid,
    ADD COLUMN IF NOT EXISTS pi_accepted_at         timestamptz,
    ADD COLUMN IF NOT EXISTS pi_accepted_by         uuid,
    ADD COLUMN IF NOT EXISTS pi_acceptance_note     text,
    -- 10-12: the refurbisher
    ADD COLUMN IF NOT EXISTS refurbisher_id         uuid,
    ADD COLUMN IF NOT EXISTS assigned_at            timestamptz,
    ADD COLUMN IF NOT EXISTS assigned_by            uuid,
    ADD COLUMN IF NOT EXISTS refurbisher_note       text,
    ADD COLUMN IF NOT EXISTS refurbisher_total      numeric(14,2),
    ADD COLUMN IF NOT EXISTS costed_at              timestamptz,
    -- 13: final bill = refurbisher_total + margin
    ADD COLUMN IF NOT EXISTS itarang_margin_pct     numeric(5,2),
    ADD COLUMN IF NOT EXISTS itarang_margin_amount  numeric(14,2),
    ADD COLUMN IF NOT EXISTS final_sent_at          timestamptz,
    ADD COLUMN IF NOT EXISTS final_sent_by          uuid,
    -- 17: redeploy | auction
    ADD COLUMN IF NOT EXISTS close_outcome          varchar(16),
    ADD COLUMN IF NOT EXISTS closed_at              timestamptz,
    ADD COLUMN IF NOT EXISTS closed_by              uuid,
    ADD COLUMN IF NOT EXISTS close_note             text;

  CREATE INDEX IF NOT EXISTS refurbishment_lots_refurbisher_idx
    ON refurbishment_lots (refurbisher_id, status) WHERE refurbisher_id IS NOT NULL;

  COMMENT ON COLUMN refurbishment_lots.status IS
    'E-292: requested | reviewed | estimated | countered | agreed | pi_sent | pi_accepted | advance_recorded | in_transit_out | received | at_refurbisher | in_progress | costed | ready | in_transit_return | delivered_back | balance_due | settled | closed | cancelled. No CHECK - vocabulary in src/lib/nbfc/recovery/refurbishment-lot-status.ts.';
  COMMENT ON COLUMN refurbishment_lots.pi_amount IS
    'E-292: the proforma invoice amount iTarang sent (step 5); accepted by the NBFC at step 6 (pi_accepted_at). Replaces the v2 approved quote as the commercial baseline.';
  COMMENT ON COLUMN refurbishment_lots.advance_status IS
    'E-271/E-292: not_required | pending (NBFC owes it) | recorded (NBFC entered a UTR) | confirmed (admin marked amount received). Offline only since E-292.';
  COMMENT ON COLUMN refurbishment_lots.itarang_margin_amount IS
    'E-292: final_total = refurbisher_total + itarang_margin_amount. Sent to the NBFC at step 13 with no re-approval.';
  COMMENT ON COLUMN refurbishment_lots.close_outcome IS
    'E-292: redeploy | auction - the NBFC choice at step 17; the lot is closed.';

  -- ---- v2 -> v3 status remap (self-limiting; re-running matches nothing) ----
  UPDATE refurbishment_lots SET status = 'estimated'        WHERE status = 'proposed';
  UPDATE refurbishment_lots SET status = 'advance_recorded' WHERE status = 'advance_paid';
  UPDATE refurbishment_lots SET status = 'in_transit_out'   WHERE status = 'delivered';
  UPDATE refurbishment_lots SET status = 'in_progress'      WHERE status = 'revision_pending';
  UPDATE refurbishment_lots
     SET status = CASE WHEN advance_status = 'confirmed' THEN 'advance_recorded' ELSE 'pi_accepted' END
   WHERE status = 'pickup_scheduled';
  -- A v2 lot waiting on its advance had an approved quote but no PI; carry the
  -- approved figures onto the PI columns so the v3 screens read coherently.
  UPDATE refurbishment_lots
     SET status            = 'pi_accepted',
         pi_amount         = COALESCE(pi_amount, quote_approved_total, estimated_total),
         pi_advance_pct    = COALESCE(pi_advance_pct, advance_pct),
         pi_advance_amount = COALESCE(pi_advance_amount, advance_amount),
         pi_accepted_at    = COALESCE(pi_accepted_at, quote_approved_at, agreed_at),
         pi_accepted_by    = COALESCE(pi_accepted_by, quote_approved_by, agreed_by),
         pi_note           = COALESCE(pi_note, 'migrated from v2 approved quote (E-292)')
   WHERE status = 'awaiting_advance';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip E-292 s3: refurbishment_lots does not exist here (apply E-270 + E-271 first)';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE refurbishment_lot_events ALTER COLUMN party TYPE varchar(16);
  COMMENT ON COLUMN refurbishment_lot_events.party IS 'E-292: nbfc | admin | refurbisher | system';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip E-292 s3 events: refurbishment_lot_events does not exist here';
END; $do$;

-- ---------------------------------------------------------------------------
-- 4. Jobs — refurbisher's per-battery cost, and the final cost that rolls into
--    the auction base price
-- ---------------------------------------------------------------------------
DO $do$ BEGIN
  ALTER TABLE refurbishment_jobs
    ADD COLUMN IF NOT EXISTS refurbisher_cost   numeric(12,2),
    ADD COLUMN IF NOT EXISTS refurbisher_parts  jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS refurbisher_note   text,
    ADD COLUMN IF NOT EXISTS costed_at          timestamptz,
    ADD COLUMN IF NOT EXISTS costed_by          uuid,
    ADD COLUMN IF NOT EXISTS final_cost         numeric(12,2);
  COMMENT ON COLUMN refurbishment_jobs.final_cost IS
    'E-292: refurbisher_cost + included accessories + pro-rata iTarang margin - what the NBFC paid for THIS battery. refurbishmentCostForBatteries() prefers it when the job is returned.';
  COMMENT ON COLUMN refurbishment_jobs.status IS
    'E-233/E-270/E-292: requested | declined | at_refurbisher | ready | returned | cancelled (+ in_progress on legacy non-lot jobs). No CHECK - vocabulary in src/lib/nbfc/recovery/refurbishment.ts.';

  -- v2 lot items that were "in workshop" are now "at the refurbisher". Legacy
  -- E-233 single jobs (lot_id IS NULL) keep in_progress.
  UPDATE refurbishment_jobs SET status = 'at_refurbisher'
   WHERE status = 'in_progress' AND lot_id IS NOT NULL;

  -- The one-open-job-per-battery index must count the new status. Recreated
  -- under a versioned name (E-289 convention); the old one is dropped so it
  -- cannot reject at_refurbisher rows as "open twice". in_progress stays for
  -- the legacy path.
  DROP INDEX IF EXISTS refurbishment_jobs_one_open_per_battery;
  CREATE UNIQUE INDEX IF NOT EXISTS refurbishment_jobs_one_open_per_battery_v3
    ON refurbishment_jobs (battery_id)
    WHERE status IN ('requested', 'in_progress', 'at_refurbisher', 'ready');
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip E-292 s4: refurbishment_jobs does not exist here (apply E-233 first)';
END; $do$;
