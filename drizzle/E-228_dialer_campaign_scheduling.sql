-- E-228: AI dialer campaign scheduling — business-hours window, weekday
--        selection, and automatic multi-day resumption.
--
-- WHY
--   A dialer campaign has no clock. advanceCampaign() places one call, the
--   provider webhook finalizes it, and finalizeCall() re-enters advanceCampaign()
--   5 seconds later — a chain reaction that runs until dialer_campaign_leads has
--   no 'pending' rows left. Nothing in that loop asks what time it is, so a
--   campaign started at 18:00 keeps dialling dealers through the night, and a
--   campaign that does not finish simply stalls until a human notices and clicks
--   Resume.
--
--   The requirement is a configured window (e.g. 11:00-15:00) on configured
--   weekdays: place calls only inside it, pause automatically at the end time,
--   and resume on the next configured day from the leads that remain.
--
-- WHY A NEW STATUS 'scheduled' AND NOT A REUSE OF 'stopped'
--   'stopped' already has a precise meaning — a human pressed Force stop, and
--   /api/ai-dialer/campaigns/[id]/stop drained the in-flight rows to 'failed'.
--   POST .../resume gates on exactly that value, campaign-status-badge.tsx
--   renders it as a grey "Stopped" pill, and every campaign report counts it as
--   an abandoned run. Overloading it would make all three lie about a campaign
--   that is simply waiting for 11am.
--
--   'scheduled' also buys the single most important safety property for free:
--   BOTH watchdogs (/api/cron/dialer-watchdog and the in-process ticker in
--   src/instrumentation-node.ts) select WHERE status = 'running', so a paused
--   campaign is outside their sweep without any change to their queries.
--
--   Free text, no CHECK and no pgEnum — the convention this family has followed
--   since E-202 (also E-218, E-220, E-221). The vocabulary lives in TypeScript
--   and is enforced by zod at the write path; ALTER TYPE on a shared drifting DB
--   is precisely what these conventions exist to avoid.
--
-- WHY THE WINDOW LIVES ON THE CAMPAIGN ROW
--   The window is per campaign, pre-filled from a global default. The global
--   default needs NO migration: assignment_config (E-120) already carries
--   working_hours_start / working_hours_end / working_days, its hours columns are
--   currently read by NOTHING (only intent_score_threshold is consumed, by
--   finalizeCall.ts), and it already has a validated admin API and UI. This file
--   therefore only adds the per-campaign override.
--
--   varchar(5) 'HH:MM' + a jsonb day array mirrors assignment_config's own shape
--   so one predicate module can read either without a translation layer.
--
-- WHY resume_after IS STORED AND NOT COMPUTED
--   The resume ticker must answer "which campaigns are due?" with an indexed
--   predicate, not by loading every paused campaign and running a date
--   computation per row. Storing the next open instant makes it
--   "WHERE status = 'scheduled' AND resume_after <= now()". It is also what makes
--   a PM2 restart mid-pause a non-event: the state is on disk, so the first tick
--   after boot re-derives everything from the row rather than from lost memory.
--
-- WHY last_advanced_at (THE MORNING-AFTER TRAP)
--   /api/cron/dialer-watchdog force-finalizes a campaign as 'stopped' when
--   campaignAgeMs > STALL_FINALIZE_AGE_MS (2h) with no lead activity in the last
--   10 minutes, and it measures age from dialer_campaigns.started_at.
--
--   A campaign paused overnight still carries YESTERDAY's started_at. The moment
--   the ticker flips it back to 'running', it is hours old with no recent
--   activity — so the watchdog would kill it before it placed its first call of
--   the day, every single day. Stamping last_advanced_at on each successful
--   advance and having the watchdog measure from
--   COALESCE(last_advanced_at, started_at) is what makes multi-day resumption
--   actually survive.
--
-- BACKWARD COMPATIBILITY
--   Every existing campaign has NULL window columns. NULL means UNSCHEDULED and
--   preserves today's behaviour exactly — dial continuously, no gate. Campaigns
--   are not retroactively constrained by this file; the only thing that applies
--   to them is the provider-level safety net in triggerBolnaCall /
--   triggerElevenLabsCall, which is code, not schema.
--
-- REQUIRED?
--   YES. Drizzle names every column of dialer_campaigns in its INSERTs, so an
--   unapplied DB throws "column does not exist" the moment any campaign is
--   created — scheduled or not. This is a hard dependency, not a feature flag.
--
-- Depends on E-109 (dialer_campaigns / dialer_campaign_leads) and, for the
-- global default only, on E-120 (assignment_config). Neither is altered here.
--
-- Additive, idempotent, and safe to re-run. No column is dropped, no type is
-- narrowed, nothing is retroactively SET NOT NULL.
-- Apply via pgAdmin Query Tool (never db:push).

-- ── 1. The per-campaign calling window ───────────────────────────────────────
ALTER TABLE dialer_campaigns
    ADD COLUMN IF NOT EXISTS window_start varchar(5);

ALTER TABLE dialer_campaigns
    ADD COLUMN IF NOT EXISTS window_end varchar(5);

ALTER TABLE dialer_campaigns
    ADD COLUMN IF NOT EXISTS window_days jsonb;

COMMENT ON COLUMN dialer_campaigns.window_start IS
    'Earliest local (IST) time this campaign may place a call, ''HH:MM''. NULL = '
    'unscheduled, i.e. pre-E-228 behaviour (dial continuously).';

COMMENT ON COLUMN dialer_campaigns.window_end IS
    'Latest local (IST) time this campaign may START a call, ''HH:MM''. A call already '
    'in flight at this time is allowed to finish. NULL = unscheduled.';

COMMENT ON COLUMN dialer_campaigns.window_days IS
    'Weekdays this campaign may dial, e.g. ["mon","tue","wed","thu","fri"]. Same '
    'vocabulary as assignment_config.working_days. NULL = unscheduled.';

-- ── 2. Pause / resume bookkeeping ────────────────────────────────────────────
ALTER TABLE dialer_campaigns
    ADD COLUMN IF NOT EXISTS paused_at timestamptz;

ALTER TABLE dialer_campaigns
    ADD COLUMN IF NOT EXISTS resume_after timestamptz;

COMMENT ON COLUMN dialer_campaigns.paused_at IS
    'When the window closed on this campaign and it moved to status=''scheduled''.';

COMMENT ON COLUMN dialer_campaigns.resume_after IS
    'Next instant the window opens. The resume ticker claims '
    'status=''scheduled'' AND resume_after <= now(). Cleared when the campaign resumes.';

-- ── 3. Real activity timestamp for the stall watchdog ────────────────────────
ALTER TABLE dialer_campaigns
    ADD COLUMN IF NOT EXISTS last_advanced_at timestamptz;

COMMENT ON COLUMN dialer_campaigns.last_advanced_at IS
    'Stamped by advanceCampaign() on every successful call placement. The stall '
    'watchdog measures inactivity from COALESCE(last_advanced_at, started_at) so a '
    'campaign resumed the morning after an overnight pause is not force-stopped on '
    'account of a stale started_at.';

-- ── 4. Index for the resume ticker ───────────────────────────────────────────
-- Partial: paused campaigns are a small minority of the table, and this is the
-- only predicate the 60s ticker runs.
CREATE INDEX IF NOT EXISTS idx_dialer_campaigns_resume
    ON dialer_campaigns (resume_after)
    WHERE status = 'scheduled';
