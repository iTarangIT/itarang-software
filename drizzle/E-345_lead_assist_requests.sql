-- =============================================================================
-- E-345 — DEALER ASKS iTARANG TO HELP ON A CUSTOMER FILE (tracker ID 183)
-- =============================================================================
-- WHY. Decided 14 Oct: iTarang may act for the dealer on the dealer's OWN file
-- (not pushed from the house) only after 1 working day with no dealer action,
-- "or when he asks". This records the asking.
--
-- WHAT. One row per ask. The dealer turns "Ask iTarang to help" on from the
-- file in the dealer portal (POST /api/lead/[id]/assist-request) and off again
-- (DELETE, sets withdrawn_at). An ask is open while withdrawn_at IS NULL; the
-- partial unique index keeps at most one open ask per lead. The CRM "Act for
-- dealer" panel shows "The dealer asked for help" and the permission rule
-- (src/lib/leads/actForDealer.ts actForDealerPermission) lets iTarang act.
--
-- The code never requires this table: without it the toggle answers that the
-- feature is not set up yet, and the permission rule reads "not asked".
--
-- Additive + idempotent. Re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_assist_requests (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id            varchar(255) NOT NULL,
    dealer_code        varchar(255),
    requested_by       uuid,
    requested_by_name  text,
    note               text,
    requested_at       timestamptz NOT NULL DEFAULT now(),
    withdrawn_at       timestamptz,
    withdrawn_by       uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_assist_requests_open_uq
    ON lead_assist_requests (lead_id) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS lead_assist_requests_lead_idx
    ON lead_assist_requests (lead_id, requested_at DESC);
