-- E-211 — Indexes for the CRM-wide notification hub.
--
-- The bell became the delivery surface for EVERY portal (admin, dealer, NBFC,
-- vendor) rather than just buyback, so `notifications` goes from a few hundred
-- rows a month to one row per recipient per business event. Three access paths
-- now run on every page load in every portal:
--
--   1. the feed          — WHERE user_id = ? ORDER BY created_at DESC LIMIT 30
--   2. the badge count   — WHERE user_id = ? AND read IS NOT TRUE
--   3. legacy dealer rows — WHERE user_id IS NULL AND dealer_id = ?
--
-- Purely additive: no columns are added, changed or dropped. Provenance
-- ("from"/"to"/"stage") and the inline-action descriptors live in the existing
-- `data` jsonb, so no schema change and no backfill were needed. `archived_at`
-- and `deleted_at` already exist (E-199/E-200).
--
-- Safe to re-run: every statement is IF NOT EXISTS.

-- 1. The feed. Composite so the ORDER BY is served by the index, not a sort.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
    ON notifications (user_id, created_at DESC);

-- 2. The badge. Partial index — unread is a small slice of the table and the
--    predicate is `IS NOT TRUE` (the column is nullable; `= false` would skip
--    NULLs, which are unread).
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
    ON notifications (user_id)
    WHERE read IS NOT TRUE;

-- 3. Dealer rows written before the hub set user_id. The feed matches these
--    with `user_id IS NULL AND dealer_id = ?`, so index that exact shape.
CREATE INDEX IF NOT EXISTS notifications_legacy_dealer_idx
    ON notifications (dealer_id, created_at DESC)
    WHERE user_id IS NULL;

-- 4. Lead-scoped lookups (the per-lead activity trail on a KYC/Acquire page).
CREATE INDEX IF NOT EXISTS notifications_lead_idx
    ON notifications (lead_id, created_at DESC);
