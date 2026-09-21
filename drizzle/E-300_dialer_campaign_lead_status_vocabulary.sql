-- E-300 — dialer campaign lead status vocabulary: "completed" means a real
-- conversation.
--
-- COMMENT-ONLY. No DDL, no data change. Safe to run any number of times.
--
-- WHY
--   dialer_campaign_leads.status used to be binary — completed | failed — and
--   'completed' was written whenever the provider returned ANY transcript. The
--   AI's own greeting produces a transcript, so a call the dealer never spoke
--   on (ringback, carrier announcement, voicemail, instant hang-up) counted as
--   Completed. On prod ~480 of ~550 'completed' rows were such calls, and the
--   busy / no-answer / rejected split sat unread inside `trigger_failed: …`.
--
--   From this change the finalizers classify every attempt
--   (src/lib/ai-dialer/campaignLeadStatus.ts, classifyCallEnd) and the status
--   column carries the result. The column stays free text — the E-202 / E-228
--   convention: no CHECK, no pgEnum; the vocabulary lives in TypeScript — so no
--   DDL is needed. What changes is what the values and the three roll-up
--   counters MEAN, and E-266's comment on calls_made ("completed_leads +
--   failed_leads") stops being true. That is what this file records.
--
-- HISTORICAL ROWS
--   Re-classified by scripts/backfill-campaign-lead-status.ts (dry run by
--   default, --apply to write) with the same classifier, then the counters are
--   re-derived by syncCampaignCounters. Deliberately not SQL here: the rule
--   parses transcripts and carrier announcements, and a second copy of it in
--   PL/pgSQL is how the two would drift.

DO $do$
BEGIN
    COMMENT ON COLUMN dialer_campaign_leads.status IS
        'pending — queued, not dialled yet (the UI labels it "Queued"). '
        'calling — a call is in flight. '
        'completed — the dealer actually SPOKE: at least one real user turn that '
        'is not a carrier announcement, on a call not answered by voicemail. '
        'no_response — rang out / not answering / switched off / unreachable. '
        'busy — SIP 486, a busy status, or a busy announcement. '
        'rejected — the dealer declined (SIP 603). '
        'voicemail — answering machine / voicemail. '
        'no_conversation — the line connected but only the AI spoke (the UI '
        'labels it "Pending"). '
        'failed — technical or configuration failure, no webhook, stopped '
        'mid-call, invalid number. '
        'skipped — never dialled: no phone, or ineligible when its turn came. '
        'Before E-300 only completed / failed were written, and completed meant '
        '"a transcript exists". Free text by convention (E-202, E-228); the '
        'vocabulary lives in src/lib/ai-dialer/campaignLeadStatus.ts.';

    COMMENT ON COLUMN dialer_campaigns.completed_leads IS
        'CONVERSATIONS: rows with status completed — the dealer spoke. Re-derived '
        'in full by syncCampaignCounters() on every campaign event. Before E-300 '
        'this counted every call that produced a transcript.';

    COMMENT ON COLUMN dialer_campaigns.failed_leads IS
        'Rows with status failed only — technical / config / no_webhook / stopped '
        'mid-call / invalid number. Busy, no_response, rejected, voicemail and '
        'no_conversation are their own statuses and are NOT counted here. '
        'Re-derived by syncCampaignCounters().';

    COMMENT ON COLUMN dialer_campaigns.calls_made IS
        'ATTEMPTS: rows in any attempted status — completed, no_response, busy, '
        'rejected, voicemail, no_conversation, failed. Skipped rows were never '
        'dialled and are excluded. Re-derived in full by syncCampaignCounters() '
        'on every campaign event. (E-266 defined it as completed + failed, which '
        'was the same set while only those two statuses existed.) Cost per call '
        'does NOT divide by this column — cost-analytics counts ai_call_logs rows '
        'itself (cost_calls).';
EXCEPTION
    WHEN undefined_table OR undefined_column THEN
        RAISE NOTICE 'skip E-300: dialer_campaigns / dialer_campaign_leads not present';
END;
$do$;
