-- E-226 — Call recording + agent attribution on touchpoints, and the
--         priority-dial NeoDove campaign.
--
-- TWO UNRELATED-LOOKING CHANGES, ONE FEATURE. Together they close the last two
-- legs of "Lead base (CRM) → campaign → dial → response/status/recording back
-- to CRM": a lead can be handed to the calling team one at a time from the CRM
-- (priority dial), and what came back from that call is visible on the lead
-- (recording + who called).
--
-- ── 1. lead_touchpoints.recording_url / external_agent_name ────────────────
--
-- Until now an inbound NeoDove disposition could carry a call recording and the
-- name of the agent who made the call, and both were thrown away: the agent's
-- name was flattened into the free-text `remarks` string, and the recording had
-- nowhere to go at all. `remarks` is prose — it cannot be filtered, grouped or
-- linked, so "show me every call NIDHI made" was unanswerable and "play that
-- call" was impossible.
--
-- Both are nullable and both stay NULL for every non-external touchpoint. They
-- are NOT NeoDove-specific columns: an inside-sales click-to-call or any future
-- telephony provider writes the same two fields, which is why they live on
-- lead_touchpoints rather than on a neodove_* table.
--
-- ⚠ THESE TWO COLUMNS ARE DELIBERATELY **NOT** MIRRORED IN src/lib/db/schema.ts.
-- lead_touchpoints is the one table in this family written through Drizzle
-- (`db.insert(leadTouchpoints)` in src/lib/touchpoints/write.ts), and Drizzle
-- names EVERY column of the table object in its INSERT. Adding them to the
-- schema object would therefore break every touchpoint write — calls, status
-- changes, escalations, reactivations — on any database where this file has not
-- been applied. They are written instead by a best-effort raw UPDATE in
-- src/lib/neodove/inbound.ts, run AFTER writeTouchpoint's transaction commits so
-- that a missing column costs a recording URL and never a touchpoint. Same
-- reasoning as E-224's two dealer_leads columns.
--
-- ── 2. neodove_campaigns.is_priority_dial ──────────────────────────────────
--
-- NeoDove has no dial API (docs/neodove-contract.md): nothing we send can make a
-- phone ring. What the CRM CAN do is push one lead, on demand, into a campaign
-- whose NeoDove-side lead distribution hands it straight to an agent — so the
-- lead surfaces at the top of someone's queue within seconds instead of in the
-- next bulk batch. That is the honest version of "single dialling initiated from
-- the CRM", and it needs exactly one thing the schema doesn't already have: a
-- flag marking WHICH campaign is that destination.
--
-- A flag rather than a config row or an env var because the destination is a
-- campaign that already exists here, with an endpoint ref, counters and a
-- mirror_config recording who staffs it. Anything else would be a second, less
-- informative name for the same row.
--
-- The partial unique index enforces the invariant the "Call now" button depends
-- on: AT MOST ONE campaign is the priority-dial destination. Without it the
-- button's `LIMIT 1` would silently pick an arbitrary campaign, and the operator
-- would have no way to tell which one took the lead.
--
-- Strictly additive and idempotent, per CLAUDE.md. Guarded: prod (db-2) has no
-- neodove_* tables at all until E-224 lands there, so that half is a no-op
-- there rather than an error.

-- ── lead_touchpoints (E-113 — exists everywhere) ───────────────────────────
DO $do$
BEGIN
    ALTER TABLE lead_touchpoints
        ADD COLUMN IF NOT EXISTS recording_url        text,
        ADD COLUMN IF NOT EXISTS external_agent_name  text;

    COMMENT ON COLUMN lead_touchpoints.recording_url IS
        'Call recording for this touchpoint, when the external system supplied one. NULL for manual touchpoints. Written by raw UPDATE, not by Drizzle - see E-226.';

    COMMENT ON COLUMN lead_touchpoints.external_agent_name IS
        'Name of the agent in the external system (e.g. a NeoDove telecaller) who made this call. Free text: they have no users row here, and inventing one would corrupt ownership attribution (BRD 0.3).';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: lead_touchpoints absent (E-113 not applied)';
END;
$do$;

-- ── neodove_campaigns (E-224 — NOT on prod yet) ────────────────────────────
DO $do$
BEGIN
    ALTER TABLE neodove_campaigns
        ADD COLUMN IF NOT EXISTS is_priority_dial boolean NOT NULL DEFAULT false;

    -- At most one priority-dial destination. Partial so the hundreds of
    -- `false` rows don't all collide with each other.
    CREATE UNIQUE INDEX IF NOT EXISTS neodove_campaigns_priority_dial_key
        ON neodove_campaigns (is_priority_dial) WHERE is_priority_dial;

    COMMENT ON COLUMN neodove_campaigns.is_priority_dial IS
        'Marks the single campaign that the CRM per-lead "Call now" action pushes into. NeoDove has no dial API - what makes this urgent is the NeoDove-side lead distribution on that campaign, not anything we send.';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: neodove_campaigns absent (E-224 not applied)';
END;
$do$;
