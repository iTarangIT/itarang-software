-- =============================================================================
-- E-302 — BUYBACK REQUESTS: a real owner (SPOC) per request (2026-09-21)
-- =============================================================================
-- WHY. Reporting Review v1.0 issue R-12. A buyback request had no owner:
-- `created_by` is the DEALER's user and buyback_deals has no assignee. The
-- Buyback Daily mail therefore guessed the SPOC as "the latest admin to act on
-- the request" — and the Sales Head is 136 of 153 admin actions, so almost
-- every kg, quote and pickup was credited to the Sales Head. Per-SPOC buyback
-- figures were not real.
--
-- WHAT CHANGED (additive; nothing dropped, nothing narrowed):
--
--   buyback_requests
--     + owner_id          text          users.id of the SPOC who owns the
--                                       request. NULL = unassigned. text, not
--                                       uuid, like every other owner column
--                                       (dealer_leads.current_owner_id).
--     + owner_assigned_at timestamptz   when it was last set.
--     + index buyback_requests_owner_idx (owner_id) WHERE owner_id IS NOT NULL
--
-- HOW IT IS SET
--   * at creation: the CRM owner of the dealer, matched through the dealer
--     account's GSTIN to a CRM lead (src/lib/leads/gstinMatch.ts) — the same
--     rule that credits revenue (R-11). No match = NULL.
--   * on the admin request page: "Claim" (me) or "Assign to" (anyone who
--     works buyback). Every change is written to buyback_activity_log as
--     action 'assign_owner'.
--
-- BACKFILL. Same GSTIN rule for existing requests; everything else stays NULL
-- and shows as "(unassigned)" in the mail until someone claims it. The old
-- "latest admin actor" guess is deliberately NOT copied in: it would bake the
-- Sales-Head-owns-everything distortion into the new column.
--
-- ⚠ REQUIRED BEFORE THE CODE DEPLOYS. The columns are mirrored in schema.ts,
-- so every bare `db.select().from(buybackRequests)` names them — on an
-- unapplied host the buyback module fails with `column "owner_id" does not
-- exist`. Old code on a new DB keeps working. Wrapped for hosts without the
-- buyback schema (E-185 was unapplied on prod for a long time).
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE buyback_requests ADD COLUMN IF NOT EXISTS owner_id text;
    ALTER TABLE buyback_requests ADD COLUMN IF NOT EXISTS owner_assigned_at timestamptz;
    CREATE INDEX IF NOT EXISTS buyback_requests_owner_idx
        ON buyback_requests (owner_id) WHERE owner_id IS NOT NULL;

    -- Backfill: the dealer account's GSTIN → a CRM lead → its current owner.
    -- Mirrors gstinMatch.ts (GSTIN_KEY + dealerLeadByGstin); keep in step.
    UPDATE buyback_requests br
       SET owner_id = m.dealer_owner_id,
           owner_assigned_at = now()
      FROM accounts a
      CROSS JOIN LATERAL (
          SELECT gm_dl.current_owner_id AS dealer_owner_id
            FROM dealer_leads gm_dl
            LEFT JOIN dealer_onboarding_applications gm_app
                   ON gm_app.id = gm_dl.dealer_onboarding_application_id
           WHERE NULLIF(upper(regexp_replace(COALESCE(a.gstin, ''), '\s', '', 'g')), '') IS NOT NULL
             AND (NULLIF(upper(regexp_replace(COALESCE(gm_dl.gstin, ''), '\s', '', 'g')), '')
                      = NULLIF(upper(regexp_replace(COALESCE(a.gstin, ''), '\s', '', 'g')), '')
                  OR NULLIF(upper(regexp_replace(COALESCE(gm_app.gst_number, ''), '\s', '', 'g')), '')
                      = NULLIF(upper(regexp_replace(COALESCE(a.gstin, ''), '\s', '', 'g')), ''))
           ORDER BY (gm_dl.lead_status = 'Converted') DESC,
                    gm_dl.closed_at DESC NULLS LAST,
                    gm_dl.created_at ASC
           LIMIT 1
      ) m
     WHERE a.id = br.dealer_entity_id
       AND br.owner_id IS NULL
       AND m.dealer_owner_id IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-302 skipped: buyback schema (E-185) not present on this database';
END;
$do$;
