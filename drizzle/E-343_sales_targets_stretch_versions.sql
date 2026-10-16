-- =============================================================================
-- E-343 — SALES TARGETS: CEO posts, Sales Head stretch, versions, ask for
-- correction — tracker ID 189 (2026-10-16)
-- =============================================================================
-- WHY. Business decision (Kartik 14 Oct, confirmed 16 Oct):
--   * only the CEO posts targets to the Sales Head;
--   * the Sales Head adds an ADD-ONLY stretch per person on top of the CEO
--     target (CEO 100 + 50 = 150), with an optional note, no CEO re-confirm;
--   * a CEO edit after Post is a DRAFT REVISION — the last posted version stays
--     in force (the Sales Head can still push it, the rep keeps seeing it, the
--     scorecard and the daily email keep it) until the revision is posted and
--     pushed; every version is kept;
--   * no Reject — the rep asks for a correction with a remark; Accept takes an
--     optional remark; the 48-hour acceptance clock runs from the FIRST push
--     and a correction never resets it.
--
-- WHAT CHANGED (additive; nothing dropped):
--
--   sales_targets
--     admin_addon                 REUSED as the Sales Head stretch (it already
--                                 was "on top of the CEO target, never
--                                 negative"; 0 on every row before E-342).
--                                 Final = ceo_target + admin_addon again.
--     stretch_note / _by / _at    the stretch's optional note, who, when
--     draft_ceo_target            the CEO's unposted revision (NULL = none)
--     next_ceo_target             a posted revision waiting for the Sales
--                                 Head's push (NULL = none)
--     next_stretch / next_stretch_note
--                                 a stretch change on a target the rep already
--                                 has, waiting for the push (NULL = none)
--     version                     the version in force (0 = never posted)
--     first_pushed_at             start of the 48-hour clock, never reset by a
--                                 correction
--     correction_requested_at / _by, correction_remark
--                                 the rep's "Ask for correction"
--     accept_remark               the rep's optional remark on Accept
--   sales_targets.sales_head_target (E-342) is no longer read. Backfill below
--   turns a Sales Head number ABOVE the CEO's into a stretch; a number BELOW
--   the CEO's cannot be a stretch and is left alone, so that rep's final
--   target goes back up to the CEO target.
--
--   sales_target_versions (new) — one row per change: target, version, event
--     (ceo_draft, posted, stretch, pushed, accepted, correction_requested,
--     baseline), the CEO target and stretch after the change, the old values,
--     the note / remark, who and when.
--
-- Code on a DB without E-343: the Targets page, My targets and every reader
-- still load (new columns are read through to_jsonb and come back null);
-- Post, stretch, push, accept, ask for correction fail with "column does not
-- exist". REQUIRED before the ID 189 release.
--
-- Idempotent: re-running is a no-op (the backfills only touch rows not yet
-- converted; the baseline history row is inserted once per target).
-- =============================================================================

DO $do$ BEGIN
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS stretch_note            text;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS stretch_by              text;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS stretch_at              timestamptz;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS draft_ceo_target        numeric(14,2);
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS next_ceo_target         numeric(14,2);
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS next_stretch            numeric(14,2);
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS next_stretch_note       text;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS version                 integer NOT NULL DEFAULT 0;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS first_pushed_at         timestamptz;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS correction_requested_at timestamptz;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS correction_requested_by text;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS correction_remark       text;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS accept_remark           text;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-343 skipped: sales_targets does not exist (apply E-303 first)';
END; $do$;

-- Stretch is add-only: never below zero (NOT VALID — existing rows are 0 or
-- positive, but the check is not re-run over history).
DO $do$ BEGIN
    ALTER TABLE sales_targets
        ADD CONSTRAINT sales_targets_stretch_not_negative CHECK (admin_addon >= 0) NOT VALID;
    ALTER TABLE sales_targets
        ADD CONSTRAINT sales_targets_next_stretch_not_negative CHECK (next_stretch IS NULL OR next_stretch >= 0) NOT VALID;
EXCEPTION
    WHEN duplicate_object THEN RAISE NOTICE 'E-343: stretch checks already exist';
    WHEN undefined_table THEN RAISE NOTICE 'E-343 skipped: sales_targets does not exist';
END; $do$;

CREATE TABLE IF NOT EXISTS sales_target_versions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_id      uuid NOT NULL REFERENCES sales_targets(id) ON DELETE CASCADE,
    version        integer NOT NULL DEFAULT 0,
    event          varchar(30) NOT NULL,
    ceo_target     numeric(14,2),
    stretch        numeric(14,2),
    old_ceo_target numeric(14,2),
    old_stretch    numeric(14,2),
    note           text,
    changed_by     text,
    changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_target_versions_target_idx ON sales_target_versions (target_id, changed_at);

-- Backfill 1 — the 48-hour clock starts at the push already recorded.
UPDATE sales_targets
   SET first_pushed_at = pushed_at
 WHERE first_pushed_at IS NULL AND pushed_at IS NOT NULL
   AND status IN ('pushed', 'accepted', 'rejected');

-- Backfill 2 — a Sales Head number above the CEO's becomes the stretch.
DO $do$ BEGIN
    UPDATE sales_targets
       SET admin_addon = sales_head_target - ceo_target,
           stretch_at  = COALESCE(stretch_at, updated_at),
           stretch_note = COALESCE(stretch_note, 'Converted from the Sales Head target (E-343)')
     WHERE sales_head_target IS NOT NULL
       AND sales_head_target > ceo_target + admin_addon;
EXCEPTION WHEN undefined_column THEN
    RAISE NOTICE 'E-343: no sales_head_target column (E-342 not applied) — nothing to convert';
END; $do$;

-- Backfill 3 — a target that was ever sent to the Sales Head is version 1.
UPDATE sales_targets SET version = 1 WHERE version = 0 AND status <> 'draft';

-- Backfill 4 — one baseline history row per posted target, so "both versions
-- are kept" holds from the first change after this release.
INSERT INTO sales_target_versions (target_id, version, event, ceo_target, stretch, note, changed_by, changed_at)
SELECT t.id, t.version, 'baseline', t.ceo_target, t.admin_addon,
       'Version in force when E-343 was applied', t.updated_by, now()
  FROM sales_targets t
 WHERE t.status <> 'draft'
   AND NOT EXISTS (SELECT 1 FROM sales_target_versions v WHERE v.target_id = t.id);
