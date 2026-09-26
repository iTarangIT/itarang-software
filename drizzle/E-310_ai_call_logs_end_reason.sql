-- E-310 — keep the provider's own word on HOW a call ended, and split the
-- "Pending" (no_conversation) campaign bucket.
--
-- DDL: additive + idempotent. Two nullable columns on ai_call_logs, plus
-- comments. No backfill in SQL. Safe to run any number of times.
--
-- WHY
--   classifyCallEnd (src/lib/ai-dialer/campaignLeadStatus.ts) is handed the
--   ElevenLabs metadata.termination_reason, the Bolna telephony_data
--   hangup_reason and Bolna's answered_by_voice_mail flag, but nothing stored
--   them, so "who hung up" was lost the moment the webhook returned.
--
--   Since 2026-09-26 the single no_conversation status (shown as "Pending",
--   which read like "not dialled yet") is split along the usual dialer
--   dispositions:
--     silent  — "Silent Call": answered, listened, never spoke (dead air)
--     hung_up — "Hung Up Early": answered, dropped during the greeting
--     no_response — a 0-second "completed" with no transcript never connected
--   The split uses call_duration today; end_reason makes it exact going
--   forward and lets the backfill re-read it.
--
-- WRITER
--   src/lib/ai/storage/callEndEvidence.ts, a guarded raw UPDATE after the
--   ai_call_logs upsert (like E-267 transcript_turns). NOT mirrored in schema.ts
--   until both databases have it, so the CRM keeps working on a host where this
--   file has not been applied yet (it logs one warning and skips the write).
--   Either deploy order is safe.
--
-- HISTORICAL ROWS
--   dialer_campaign_leads rows are re-classified by
--   scripts/backfill-campaign-lead-status.ts (dry run by default, --apply to
--   write). Past ai_call_logs rows keep end_reason NULL: the reason was never
--   stored, so those are split on duration + transcript alone.

DO $do$
BEGIN
    ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS end_reason text;
    ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS answered_by_voicemail boolean;

    COMMENT ON COLUMN ai_call_logs.end_reason IS
        'E-310. How the provider says the call ended, verbatim: ElevenLabs '
        'metadata.termination_reason / Bolna telephony_data.hangup_reason. NULL '
        'on rows written before E-310 or when the provider sent none.';

    COMMENT ON COLUMN ai_call_logs.answered_by_voicemail IS
        'E-310. Bolna telephony_data.answered_by_voice_mail (answering-machine '
        'detection). NULL when AMD was off or the provider does not report it.';

    COMMENT ON COLUMN dialer_campaign_leads.status IS
        'pending — queued, not dialled yet (the UI labels it "Queued"). '
        'calling — a call is in flight. '
        'completed — the dealer actually SPOKE: at least one real user turn that '
        'is not a carrier announcement, on a call not answered by voicemail. '
        'no_response — rang out / not answering / switched off / unreachable, '
        'including a 0-second "completed" with no transcript. '
        'busy — SIP 486, a busy status, or a busy announcement. '
        'rejected — the dealer declined (SIP 603). '
        'voicemail — answering machine / voicemail / IVR. '
        'silent — "Silent Call": answered and listened, only the AI spoke (E-310). '
        'hung_up — "Hung Up Early": answered, dropped during the greeting (E-310). '
        'no_conversation — LEGACY, the single bucket silent / hung_up were split '
        'from (was labelled "Pending"); no longer written. '
        'failed — technical or configuration failure, no webhook, stopped '
        'mid-call, invalid number. '
        'skipped — never dialled: no phone, or ineligible when its turn came. '
        'Free text by convention (E-202, E-228); the vocabulary lives in '
        'src/lib/ai-dialer/campaignLeadStatus.ts.';

    COMMENT ON COLUMN dialer_campaigns.calls_made IS
        'ATTEMPTS: rows in any attempted status — completed, no_response, busy, '
        'rejected, voicemail, silent, hung_up, no_conversation (legacy), failed. '
        'Skipped rows were never dialled and are excluded. Re-derived in full by '
        'syncCampaignCounters() on every campaign event. Cost per call does NOT '
        'divide by this column — cost-analytics counts ai_call_logs rows itself.';
EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'skip E-310: ai_call_logs / dialer_campaign_leads not present';
END;
$do$;
