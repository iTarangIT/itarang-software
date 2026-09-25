-- =============================================================================
-- E-305 — ECOFY LEADS: leads pushed from Ecofy + the sync ledger (2026-09-24)
-- =============================================================================
-- WHY. docs/ECOFY_INTEGRATION.md §6: Ecofy (sandbox-ecofy.itarang.com) pushes
-- Warm/Hot leads to the CRM as signed events. The two systems keep separate
-- databases, so the CRM stores its own copy of each lead, keyed by Ecofy's
-- case id, and shows it to the Sales Head under "Ecofy Leads".
--
-- WHAT CHANGED (additive; two new tables, nothing else touched):
--
--   ecofy_leads — one row per Ecofy case (UNIQUE ecofy_case_id)
--     id               uuid, returned to Ecofy as crmLeadId
--     version          Ecofy's lead.version; a snapshot with a LOWER version
--                      than the stored one is ignored (§3)
--     stage/temperature/queue_entered_at …  flattened from the lead snapshot
--     customer_*       flattened from lead.customer
--     snapshot         the full last-applied lead object, verbatim
--     last_change      the `change` block of the last lead.stage_changed
--
--   ecofy_sync_events — the ledger, both directions
--     UNIQUE (direction, event_id) is the dedupe: Ecofy delivers at-least-once,
--     so a replayed inbound eventId inserts nothing and gets the stored reply;
--     an outbound retry must reuse its eventId (§4), so it updates the same row.
--
-- No backfill. Required before the Ecofy code deploys (the route and pages
-- read these tables); nothing else depends on them.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ecofy_leads (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ecofy_case_id         text        NOT NULL,
    case_no               text,
    version               integer     NOT NULL DEFAULT 0,
    stage                 varchar(20),
    sub_status            text,
    segment               varchar(40),
    temperature           varchar(10),
    lead_source           varchar(60),
    owner                 varchar(40),
    qualified_by_name     text,
    queue_entered_at      timestamptz,
    product_interest      varchar(60),
    avg_monthly_bill_inr  numeric(14,2),
    sanctioned_load_kw    numeric(10,2),
    existing_backup       text,
    preferred_call_time   text,
    closure_reason        text,
    customer_name         text,
    customer_mobile       varchar(20),
    customer_alt_mobile   varchar(20),
    customer_email        text,
    customer_type         varchar(40),
    business_name         text,
    address               text,
    city                  text,
    state                 varchar(40),
    pincode               varchar(12),
    preferred_language    varchar(20),
    property_type         varchar(40),
    ecofy_url             text,
    snapshot              jsonb       NOT NULL DEFAULT '{}'::jsonb,
    last_change           jsonb,
    last_event_id         text,
    last_event_type       varchar(60),
    last_event_at         timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ecofy_leads_case_id_uniq
    ON ecofy_leads (ecofy_case_id);
-- The Sales Head list: Hot first, then oldest queue entry.
CREATE INDEX IF NOT EXISTS ecofy_leads_queue_idx
    ON ecofy_leads (temperature, queue_entered_at);

CREATE TABLE IF NOT EXISTS ecofy_sync_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    direction       varchar(10) NOT NULL,   -- 'inbound' | 'outbound'
    event_id        text        NOT NULL,
    event_type      varchar(60) NOT NULL,
    ecofy_case_id   text,
    ecofy_lead_id   uuid,
    payload         jsonb       NOT NULL,
    response        jsonb,
    http_status     integer,
    attempts        integer     NOT NULL DEFAULT 1,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ecofy_sync_events_direction_chk CHECK (direction IN ('inbound', 'outbound'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ecofy_sync_events_direction_event_uniq
    ON ecofy_sync_events (direction, event_id);
CREATE INDEX IF NOT EXISTS ecofy_sync_events_case_idx
    ON ecofy_sync_events (ecofy_case_id, created_at);
