-- E-233: refurbishment jobs, and the inspection fields the auction needs.
--
-- Phase 2 of docs/battery-auction-flow.html. Depends on E-232 (recovery_batteries).
--
-- ============================================================================
-- refurbishment_jobs — BRD §5
-- ============================================================================
--   An NBFC raises a job against a recovered battery, the iTarang workshop
--   works it, and the battery comes back and re-enters at "ready for auction".
--   None of that exists today: `nbfc_recovery_pipeline` has a `refurbishable`
--   stage and no way to record what was actually done, by whom, or what it
--   cost.
--
-- WHY estimated_cost AND actual_cost, NOT ONE `cost`
--   The estimate is what the NBFC agreed to before work started; the actual is
--   what the workshop spent. Collapsing them loses the only number anyone can
--   audit a workshop against, and it is precisely the pair a dispute is about.
--   Both nullable: a job can be raised before anybody has priced it.
--
-- WHY accessories IS jsonb AND NOT THREE COLUMNS
--   BRD §15 requires charger, harness and SOC meter to be NEW on every
--   refurbished battery, costed separately (~₹7–8k) and then rolled into the
--   base price so the dealer sees ONE number. Three boolean+price column pairs
--   would need a migration the first time a fourth accessory exists, and this
--   list is exactly the kind that grows. The shape is enforced in
--   src/lib/nbfc/recovery/refurbishment.ts, the same way every other jsonb
--   payload in this family is (nbfc_battery_evaluations.step1/2/3 set the
--   precedent).
--
-- WHY NO FK TO recovery_batteries
--   Consistent with the whole nbfc_* family, which carries no FK constraints
--   (nbfc_battery_evaluations has no FK to the pipeline row it names either).
--   These tables are applied by hand across databases that drift, and a FK
--   turns a missing parent row into a failed INSERT at runtime rather than a
--   dangling id somebody can repair.
--
-- ============================================================================
-- nbfc_battery_evaluations — two additive columns
-- ============================================================================
--   `photo_urls` closes BRD §20: images are captured ONCE at inspection and
--   reused verbatim as the auction images. Note the battery master
--   (recovery_batteries.image_urls, E-232) is the canonical gallery; this
--   column records what THIS evaluation saw, so a re-inspection after
--   refurbishment does not overwrite the before pictures.
--
--   `condition_grade` records the three-way grade the auction sells on
--   (new | refurbished | partial_working, BRD §6). It is stored rather than
--   recomputed because the SOH bands may be retuned, and a lot already sold as
--   "partial working" must not silently re-grade itself afterwards.
--
-- NOT REQUIRED for existing behaviour: nothing reads these columns until the
--   Phase 2 code ships. But `recordEvaluation()` writes through the Drizzle
--   query builder, which names every column of the table in its INSERT, so
--   once schema.ts mirrors them an unapplied database throws
--   `column "photo_urls" does not exist` on the first evaluation saved.
--
-- Additive and idempotent — safe to re-run. Apply with
--   node --env-file=.env.local scripts/apply-e233.mjs

BEGIN;

CREATE TABLE IF NOT EXISTS refurbishment_jobs (
  id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid         NOT NULL,
  battery_id             uuid         NOT NULL,
  recovery_pipeline_id   uuid,
  requested_by_user_id   uuid,
  assigned_workshop      varchar(160),
  -- Free-form task list: [{ key, label, done, note }]. Shape enforced in
  -- src/lib/nbfc/recovery/refurbishment.ts.
  checklist              jsonb        NOT NULL DEFAULT '[]'::jsonb,
  -- BRD §15: charger, harness, SOC meter — always NEW, costed separately and
  -- then rolled into the base price so the dealer sees one number.
  accessories            jsonb        NOT NULL DEFAULT '[]'::jsonb,
  estimated_cost         numeric(12,2),
  actual_cost            numeric(12,2),
  status                 varchar(24)  NOT NULL DEFAULT 'requested',
  notes                  text,
  requested_at           timestamptz  NOT NULL DEFAULT now(),
  started_at             timestamptz,
  returned_at            timestamptz,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refurbishment_jobs_tenant_idx
  ON refurbishment_jobs (tenant_id);
CREATE INDEX IF NOT EXISTS refurbishment_jobs_battery_idx
  ON refurbishment_jobs (battery_id);
CREATE INDEX IF NOT EXISTS refurbishment_jobs_status_idx
  ON refurbishment_jobs (status);

-- At most ONE open job per battery. Without this, two operators raising a job
-- for the same battery on the same day produce two, and "the" refurbishment
-- cost of that battery stops having an answer — which is the number that rolls
-- into the auction base price. Partial, so the history of completed jobs is
-- unbounded and a battery may legitimately be refurbished more than once.
CREATE UNIQUE INDEX IF NOT EXISTS refurbishment_jobs_one_open_per_battery
  ON refurbishment_jobs (battery_id)
  WHERE status IN ('requested', 'in_progress');

COMMENT ON TABLE refurbishment_jobs IS
  'E-233: one workshop job per recovered battery (BRD §5). NBFC raises it, '
  'iTarang works it, battery re-enters at ready_for_auction. Refurbishment is '
  'RECOMMENDED, NEVER MANDATORY — the recovery stage machine allows '
  'needs_inspection -> ready_for_auction directly.';

COMMENT ON COLUMN refurbishment_jobs.status IS
  'E-233: requested | in_progress | returned | cancelled. No CHECK — vocabulary '
  'is enforced in src/lib/nbfc/recovery/refurbishment.ts, per this family''s '
  'convention (cf. E-202/E-218/E-226/E-231/E-232).';

COMMENT ON COLUMN refurbishment_jobs.accessories IS
  'E-233: [{ key, label, unit_cost, included }] — charger, harness, SOC meter. '
  'BRD §15 requires these to be NEW on every refurbished battery. Costed '
  'separately here, then rolled into the lot base price so the dealer sees one '
  'number rather than an itemised bill.';

COMMENT ON COLUMN refurbishment_jobs.estimated_cost IS
  'E-233: what the NBFC agreed to before work started. Kept separate from '
  'actual_cost because the pair is the only thing a workshop can be audited '
  'against, and it is exactly what a dispute is about.';

ALTER TABLE nbfc_battery_evaluations
  ADD COLUMN IF NOT EXISTS photo_urls      text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS condition_grade varchar(24);

COMMENT ON COLUMN nbfc_battery_evaluations.photo_urls IS
  'E-233: relative /api/files/<bucket>/<key> paths seen by THIS evaluation '
  '(BRD §20 — captured once at inspection, reused as the auction images). '
  'recovery_batteries.image_urls is the canonical gallery; this column exists '
  'so a re-inspection after refurbishment does not overwrite the before shots.';

COMMENT ON COLUMN nbfc_battery_evaluations.condition_grade IS
  'E-233: new | refurbished | partial_working (BRD §6). STORED, not recomputed '
  'from SOH, because the bands may be retuned later and a battery already sold '
  'as partial_working must not silently re-grade itself afterwards.';

COMMIT;
