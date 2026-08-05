------------------------------------------------------------------------------
-- E-224: NeoDove ⇄ iTarang two-way lead sync.
--
-- PROBLEM. Telecalling runs in NeoDove (connect.neodove.com, a Vyapar product);
-- the prospect pool, the scraper, the AI dialer and the whole loan-origination
-- funnel run here. The two systems share nothing, so a lead worked in NeoDove
-- is invisible in the CRM and vice versa.
--
-- THE CONSTRAINT THAT SHAPES THIS SCHEMA. NeoDove has no read API. Its entire
-- programmable surface is:
--   * inbound  — a per-campaign "Custom Integration" endpoint we POST leads to
--                (the URL itself is the credential; there is no key/header auth)
--   * outbound — Workflows → Send Webhook, which POSTs to us on lead created /
--                call connected / call not connected, with custom headers
-- There is NO way to query NeoDove for state. So a webhook NeoDove drops is
-- gone: unrecoverable by any query. `neodove_sync_events` is therefore not a
-- debug log, it is the reconciliation ledger — it is what lets us diff a
-- NeoDove CSV export against what we actually received and backfill the gap.
--
-- WHY NOT REUSE dialer_campaigns. That table drives the AI voice dialer:
-- advanceCampaign() claims rows FOR UPDATE SKIP LOCKED and places real Bolna
-- calls, and /api/cron/ai-dialer + dialer-watchdog sweep for status='running'.
-- A NeoDove row parked there would eventually be picked up and dialled by a
-- robot against an audience meant for human agents. Separate table; the two are
-- UNIONed at the API layer for the unified Campaigns tab.
--
-- WHY A LINK TABLE AND NOT COLUMNS ON dealer_leads. One lead can legitimately
-- sit in several NeoDove campaigns over time (a retry push, a different
-- product campaign). Columns would collapse that to the most recent push and
-- destroy the per-campaign push/disposition counters.
--
-- WHY NO RAW ENDPOINT URL IS STORED. The push URL carries an opaque per-campaign
-- token and is the only credential NeoDove issues. push_endpoint_ref holds the
-- NAME of an env var (e.g. 'NEODOVE_PUSH_ENDPOINT_DEALER_Q3'), resolved
-- server-side. A DB leak must not be a NeoDove write capability.
--
-- Strictly additive and idempotent. With zero rows in these tables and
-- NEODOVE_ENABLED unset, runtime behaviour is byte-for-byte unchanged.
------------------------------------------------------------------------------

-- ── Campaign mapping: a CRM campaign ⇄ a NeoDove campaign ──────────────────
CREATE TABLE IF NOT EXISTS neodove_campaigns (
  id                    text PRIMARY KEY,
  name                  text        NOT NULL,
  -- The campaign's name as it appears in the NeoDove UI. Free text: NeoDove
  -- exposes no campaign id over any API, so this is the only human-checkable
  -- link between the two sides.
  neodove_campaign_name text,
  -- NAME of the env var holding the Custom Integration endpoint, never the URL.
  push_endpoint_ref     text,
  -- NAME of the env var holding the "Endpoint(Update only)" URL. Nullable:
  -- NeoDove's update-match semantics are undocumented and must be probed before
  -- we rely on them (see docs/neodove-contract.md).
  update_endpoint_ref   text,
  -- Same RegionSelection jsonb shape the AI-dialer start modal already emits,
  -- so the existing audience builder is reused verbatim.
  audience_filter       jsonb,
  -- draft | pushing | active | paused | completed
  status                varchar(20) NOT NULL DEFAULT 'draft',
  total_pushed          integer     NOT NULL DEFAULT 0,
  push_failed           integer     NOT NULL DEFAULT 0,
  dispositions_received integer     NOT NULL DEFAULT 0,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS neodove_campaigns_status_idx
  ON neodove_campaigns (status, created_at DESC);

CREATE INDEX IF NOT EXISTS neodove_campaigns_created_by_idx
  ON neodove_campaigns (created_by, created_at DESC);


-- ── Which of our leads are in which NeoDove campaign ───────────────────────
CREATE TABLE IF NOT EXISTS neodove_lead_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Soft FK to dealer_leads.id, matching the dialer_campaign_leads precedent
  -- (that table documents why: lead rows outlive campaign bookkeeping).
  dealer_lead_id      text NOT NULL,
  neodove_campaign_id text NOT NULL REFERENCES neodove_campaigns(id) ON DELETE CASCADE,
  -- NeoDove's own lead id, IF its create response returns one. Unknown until
  -- Phase 0 probing — nullable, and the inbound handler falls back to matching
  -- on normalised phone when it is absent.
  neodove_lead_id     text,
  -- pending | pushed | failed | skipped_dedup | skipped_excluded
  push_status         varchar(24) NOT NULL DEFAULT 'pending',
  push_error          text,
  pushed_at           timestamptz,
  last_event_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- One row per (lead, campaign). Makes re-pushing a campaign idempotent at the
-- DB level rather than relying on the Redis claim alone.
CREATE UNIQUE INDEX IF NOT EXISTS neodove_lead_links_lead_campaign_key
  ON neodove_lead_links (dealer_lead_id, neodove_campaign_id);

-- Partial: most rows will have a NULL neodove_lead_id and would otherwise all
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS neodove_lead_links_neodove_lead_key
  ON neodove_lead_links (neodove_lead_id) WHERE neodove_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS neodove_lead_links_campaign_status_idx
  ON neodove_lead_links (neodove_campaign_id, push_status);

-- The inbound hot path: resolve a webhook back to one of our leads.
CREATE INDEX IF NOT EXISTS neodove_lead_links_lead_idx
  ON neodove_lead_links (dealer_lead_id, last_event_at DESC);


-- ── Append-only sync ledger, both directions ───────────────────────────────
CREATE TABLE IF NOT EXISTS neodove_sync_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'outbound' (we pushed) | 'inbound' (NeoDove called us)
  direction           varchar(10) NOT NULL,
  event_type          varchar(50),
  neodove_campaign_id text REFERENCES neodove_campaigns(id) ON DELETE SET NULL,
  dealer_lead_id      text,
  -- NeoDove's event/lead identifier for an inbound delivery. Doubles as the
  -- idempotency key (see the partial unique index below) and as the value
  -- written to lead_touchpoints.external_event_id, so a replayed webhook is
  -- refused in two independent places.
  external_event_id   text,
  http_status         integer,
  request_payload     jsonb,
  response_payload    jsonb,
  error               text,
  attempts            integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Inbound idempotency. Same idiom as whatsapp_messages.provider_message_id:
-- the webhook route INSERTs .onConflictDoNothing() and treats "zero rows
-- returned" as "already processed, skip". Partial because outbound rows have no
-- external_event_id and must not compete for this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS neodove_sync_events_inbound_key
  ON neodove_sync_events (external_event_id)
  WHERE direction = 'inbound' AND external_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS neodove_sync_events_campaign_idx
  ON neodove_sync_events (neodove_campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS neodove_sync_events_lead_idx
  ON neodove_sync_events (dealer_lead_id, created_at DESC);

-- Failure triage: "what went wrong in the last hour" without a seq scan.
CREATE INDEX IF NOT EXISTS neodove_sync_events_errors_idx
  ON neodove_sync_events (created_at DESC) WHERE error IS NOT NULL;


-- ── dealer_leads: cheap list-view badges without a join ────────────────────
-- Denormalised on purpose. The /leads table renders 50 rows a page and a
-- "synced to NeoDove" chip must not cost a join against a link table that has
-- one row per (lead, campaign).
ALTER TABLE dealer_leads
  ADD COLUMN IF NOT EXISTS neodove_synced_at  timestamptz,
  -- NULL (never touched) | pushed | failed | inbound
  ADD COLUMN IF NOT EXISTS neodove_sync_status varchar(20);

CREATE INDEX IF NOT EXISTS dealer_leads_neodove_sync_idx
  ON dealer_leads (neodove_sync_status, neodove_synced_at DESC)
  WHERE neodove_sync_status IS NOT NULL;

COMMENT ON COLUMN neodove_campaigns.push_endpoint_ref IS
  'E-224: the NAME of an env var holding the Custom Integration URL — never the URL itself. That URL is the only credential NeoDove issues, so a DB read must not confer write access to their system.';
COMMENT ON COLUMN neodove_sync_events.external_event_id IS
  'E-224: NeoDove''s event id. Idempotency key for inbound deliveries (partial unique index) and the value written to lead_touchpoints.external_event_id, whose own partial unique index (E-113) is the second line of defence against a replayed webhook.';
COMMENT ON TABLE neodove_sync_events IS
  'E-224: reconciliation ledger, not a debug log. NeoDove has no read API, so a dropped webhook is unrecoverable by query — this table is what a CSV export is diffed against to find and backfill the gap.';
