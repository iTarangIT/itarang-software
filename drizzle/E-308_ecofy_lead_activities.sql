-- =============================================================================
-- E-308 — ECOFY LEAD ACTIVITIES: CRM-side work log with sync-to-Ecofy (2026-09-24)
-- =============================================================================
-- WHY. Calls, remarks, follow-ups and meeting bookings on an Ecofy lead are
-- normally written straight to Ecofy. When Ecofy cannot take them (unreachable,
-- 5xx, or it refuses the integration user — "Act-as user is not an active user
-- of this tenant"), the ASM / ISR must still be able to work the lead. The CRM
-- keeps the entry here and a ticker replays it to Ecofy once Ecofy accepts.
--
-- WHAT CHANGED (additive; a new table, nothing else touched):
--
--   ecofy_lead_activities — one row per CRM-recorded call / remark / follow-up
--   (kind 'activity') or meeting booking (kind 'appointment').
--     payload       the validated action body, exactly as it will be sent
--     sync_status   'pending' → 'synced' | 'failed' (Ecofy rejected the data
--                   itself, e.g. a gate — retrying would never succeed)
--     sync_attempts / last_attempt_at / synced_at / sync_error
--
-- No backfill. Required before the code that writes it deploys.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ecofy_lead_activities (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ecofy_lead_id    uuid        NOT NULL,
    kind             varchar(20) NOT NULL,
    payload          jsonb       NOT NULL,
    created_by       uuid,
    created_by_name  text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    sync_status      varchar(12) NOT NULL DEFAULT 'pending',
    sync_attempts    integer     NOT NULL DEFAULT 0,
    last_attempt_at  timestamptz,
    synced_at        timestamptz,
    sync_error       text,
    CONSTRAINT ecofy_lead_activities_kind_chk CHECK (kind IN ('activity', 'appointment')),
    CONSTRAINT ecofy_lead_activities_sync_chk CHECK (sync_status IN ('pending', 'synced', 'failed'))
);

CREATE INDEX IF NOT EXISTS ecofy_lead_activities_lead_idx
    ON ecofy_lead_activities (ecofy_lead_id, created_at);
CREATE INDEX IF NOT EXISTS ecofy_lead_activities_pending_idx
    ON ecofy_lead_activities (created_at) WHERE sync_status = 'pending';
