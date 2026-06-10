-- E-161 — iTarang CEO approval gate for out-of-band financing-offer deviations.
-- BRD Addendum V0.3.1 §5.1 (iTarang CEO platform role) + §13.3.3/§13.3.4 (deviation
-- logic + CEO approval gate, 4-hour SLA).
--
-- Additive only. A financing offer whose terms fall OUTSIDE the matched loan
-- product's bands (ROI / tenure / loan amount) is held from the dealer's
-- compare-and-pick screen until the iTarang CEO approves it. Approval reuses the
-- existing dual_approval_requests framework (action_type='financing_offer_deviation',
-- approver_role='itarang_ceo'); these columns cache the decision on the offer so
-- the dealer-facing query can gate cheaply.
--
-- In-band offers default to ceo_approval_status='not_required' and behave exactly
-- as before — existing rows are backfilled to 'not_required' by the column default,
-- so nothing already submitted is suddenly hidden.

ALTER TABLE nbfc_financing_offers
  ADD COLUMN IF NOT EXISTS deviation_detected   boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deviation_fields      jsonb,
  ADD COLUMN IF NOT EXISTS deviation_reason      text,
  ADD COLUMN IF NOT EXISTS ceo_approval_status   varchar(24)  NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS ceo_approval_request_id uuid,
  ADD COLUMN IF NOT EXISTS ceo_decided_by        uuid,
  ADD COLUMN IF NOT EXISTS ceo_decided_at        timestamptz;

-- Guard the cached status to the known set. NOT VALID so the default-backfilled
-- existing rows ('not_required') are accepted without a full-table validation.
DO $do$ BEGIN
  ALTER TABLE nbfc_financing_offers
    ADD CONSTRAINT nbfc_financing_offers_ceo_status_chk
    CHECK (ceo_approval_status IN ('not_required','pending','approved','rejected')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'ceo_status check exists, skipping';
END; $do$;

-- The dealer-facing offers query filters on this; index the held/pending rows.
CREATE INDEX IF NOT EXISTS nbfc_financing_offers_ceo_status_idx
  ON nbfc_financing_offers (ceo_approval_status);

COMMENT ON COLUMN nbfc_financing_offers.ceo_approval_status IS
  'not_required | pending | approved | rejected — gate for releasing the offer to the dealer (E-161).';
COMMENT ON COLUMN nbfc_financing_offers.deviation_fields IS
  'jsonb array of out-of-band field descriptors {field,value,min,max} captured at submission (E-161).';
