------------------------------------------------------------------------------
-- E-249 — AI-connected hard block, campaign lead-state filters, scrape-run
--         campaigns, and AI / inside-sales dispositions: VOCABULARY ONLY.
--
-- ⚠ THIS FILE ADDS NO COLUMNS, TABLES, INDEXES OR CONSTRAINTS. It is
-- COMMENT-only, exactly like E-245_offer_close_vocabulary.sql. Applying it is
-- OPTIONAL and the application behaves identically with or without it, on every
-- environment. Read that sentence again before skipping the rest of this header.
--
-- WHY THERE IS NO DDL. The feature writes several things that did not exist
-- before, and not one of them needs a schema change:
--
--   lead_touchpoints.touchpoint_type     = 'ai_call'
--   lead_touchpoints.disposition / _bucket / connect_status  (two new writers)
--   dealer_leads.last_disposition_source = 'ai_dialer' | 'inside_sales'
--   dialer_campaign_leads.call_outcome   = 'ineligible_ai_connected'
--   dialer_campaigns.region_filter       gains filters{} / kind:"scrape_run"
--
--   * touchpoint_type is varchar(50) with NO CHECK, and 'ai_call' has been a
--     legal member of TOUCHPOINT_TYPE (src/lib/lifecycle/touchpointTypes.ts)
--     since Part 0. E-249 is the FIRST code anywhere that writes it: the AI
--     dialer wrote ai_call_logs and the dealer_leads rollups but never a
--     touchpoint, so AI calls were invisible to the lead timeline, to the E-236
--     disposition filters and to every connect-rate figure. Measured on
--     database-1, 2026-08-18: 2,445 inside_sales_call rows, 0 ai_call rows.
--
--   * last_disposition_source is varchar(20) with NO CHECK. E-236's own header
--     says the column exists so "an inside-sales rep logging a call by hand
--     against the same vocabulary needs no further migration". This is that day,
--     and the AI dialer arrived with it.
--
--   * the E-236 and E-226 columns on both tables are unchanged.
--
--   * the campaign lead-state filters and the scrape-run campaign ride inside
--     the EXISTING dialer_campaigns.region_filter jsonb. A real audience_filter
--     column would have been better naming but would make this file a HARD,
--     ORDERED prerequisite on both RDS hosts — dialer_campaigns IS mirrored in
--     schema.ts, so a database without the column fails on every campaign
--     INSERT. See the E-247 / E-248 rows for what that costs in practice.
--
-- WHY NO INDEX. The AI-connected block is a read-time
--   NOT EXISTS (SELECT 1 FROM ai_call_logs
--                WHERE lead_id = dl.id AND transcript IS NOT NULL)
-- against a table that already carries ai_call_logs_lead_id_idx. Measured on
-- database-1: ai_call_logs holds 298 rows — 83 with a transcript, 27 with
-- signals, 4 with a band — against 3,941 dealer_leads. A GIN index on
-- ai_call_logs.signals would index 27 documents to accelerate a scan the planner
-- already costs at two pages; it would never be chosen. A denormalised
-- dealer_leads.ai_connected_at was rejected for the same reason, plus it would
-- need a backfill and a new write in BOTH providers' private upsertAiCallLog —
-- two places to drift, for microseconds.
--
--   Revisit at: ~50k ai_call_logs rows   -> add (lead_id, created_at DESC)
--               ~250k rows with signals  -> reconsider GIN
--               /leads p95 > 800ms with an AI filter engaged -> measure first
--
-- IDEMPOTENT: COMMENT ON is a full replace, so re-running is a no-op.
-- ADDITIVE: no ALTER, no DROP, no data touched. Every block is guarded so a
-- database missing a table raises a NOTICE rather than an error.
------------------------------------------------------------------------------

DO $do$
BEGIN
    COMMENT ON COLUMN dealer_leads.last_disposition_source IS
        'E-236/E-249: which system recorded last_disposition - neodove '
        '(webhook, src/lib/neodove/inbound.ts), ai_dialer (AI call '
        'finalization, src/lib/ai/storage/callTouchpoint.ts) or inside_sales '
        '(a reps Log Touchpoint form, src/lib/touchpoints/write.ts). '
        'varchar(20), no CHECK - enforced in the writers. THERE IS NO SOURCE '
        'PRECEDENCE: all three guard on last_disposition_at <= the new call '
        'time, so the LATEST CALL owns the row whichever system observed it. '
        'This column says WHO recorded it, never who wins.';

    COMMENT ON COLUMN dealer_leads.last_disposition IS
        'E-236/E-249: L3 of the CC disposition tree from the most recent call by '
        'ANY caller - NeoDove agent, inside-sales rep, or the AI dialer. '
        'Denormalised from lead_touchpoints so the /leads filter is indexable. '
        'NOT mirrored in src/lib/db/schema.ts - see E-236 header. A disposition '
        'NEVER moves dealer_leads.lead_status: the BRD 0.7 pipeline is a human '
        'decision. Restated here because E-249 added two writers.';
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: dealer_leads disposition columns absent (E-236 not applied)';
END;
$do$;

DO $do$
BEGIN
    COMMENT ON COLUMN lead_touchpoints.touchpoint_type IS
        'BRD 0.13 / E-249: varchar(50), no CHECK - TOUCHPOINT_TYPE in '
        'src/lib/lifecycle/touchpointTypes.ts is the only enforcement. '
        'ai_call had ZERO rows until E-249. AI rows carry performed_by = NULL, '
        'which is what keeps them out of every per-rep report: reports.ts '
        'dailyActivity and funnelByOwner, and dashboard.ts leads_worked_today '
        'and the status-change hygiene KPI, all filter performed_by IS NOT '
        'NULL. is_engaged = false (BRD 0.1 defines engagement as a HUMAN '
        'interaction). sync_method = system, or reconciliation for rows created '
        'by scripts/backfill-ai-call-touchpoints.ts. external_system = the '
        'provider and external_event_id = the provider call id, which is also '
        'ai_call_logs.call_id - that pair is the idempotency key, via E-113 '
        'lead_touchpoints_external_uniq.';

    COMMENT ON COLUMN lead_touchpoints.disposition IS
        'E-236/E-249: the disposition for THIS call. Written by a raw UPDATE - '
        'AFTER the transaction for the NeoDove webhook and the AI dialer (an '
        'event that cannot be re-fetched must never lose the TOUCHPOINT to a '
        'missing column), and INSIDE the transaction for the inside-sales form '
        '(the rep watched themselves pick it; a save that silently dropped it '
        'is a lie on screen, and their submission is retryable). NULL on a '
        'CONNECTED AI call means the sheet has no honest label for it - an '
        'unanalysable or never-analysed call - and COUNT(*) over that condition '
        'is the extraction-failure rate, visible in the CRM.';

    COMMENT ON COLUMN lead_touchpoints.external_stage IS
        'E-236/E-249: the external systems own words, verbatim. NeoDove: '
        'lead_stage_name. AI dialer: the RAW PROVIDER STATUS (no_answer, busy, '
        'call-disconnected, completed) the disposition was mapped FROM, so a '
        'bad mapping is diagnosable with GROUP BY external_stage, disposition '
        'without re-reading ai_call_logs.';

    COMMENT ON COLUMN lead_touchpoints.external_tag IS
        'E-236/E-249: NeoDove lead_tag_name verbatim; for AI calls the computed '
        'band (Qualified/Warm/Cold/Disqualified), or dropped_empty or '
        'needs_review. The band is the fact the L2 bucket CANNOT carry: an AI '
        'qualification call maxes out at Warm, because every label in the '
        'sheets Hot bucket names a commercial artefact (quotation, negotiation, '
        'documents) that only a human produces.';
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: lead_touchpoints absent (E-113 not applied)';
END;
$do$;

DO $do$
BEGIN
    COMMENT ON COLUMN dialer_campaign_leads.call_outcome IS
        'Free text, no constraint. Known values: no_phone, '
        'ineligible_active_lead, ineligible_ai_connected (E-249: the lead had '
        'already had a CONNECTED AI call - an ai_call_logs row with a '
        'transcript - and the AI can never dial it again; enforced at enrolment '
        'in createCampaign and re-checked before every dial in '
        'advanceCampaign), no_webhook, stopped_by_user, dropped_empty, '
        'needs_review, trigger_failed: <reason>, trigger_exception: <reason>, '
        'or the analyzer outcome for a completed call.';

    COMMENT ON COLUMN dialer_campaigns.region_filter IS
        'The campaigns AUDIENCE blob, stored verbatim as the client sent it. '
        'Despite the name it is NOT region-only and has not been since E-109. '
        'Keys: states[], cities[{state,city}], pincodes[], groupIds[], '
        'groupNames[] (server-snapshotted at start so history survives group '
        'renames), kind (list - read as an EQUALITY at /api/ai-dialer/campaigns '
        'to drive the Lists tab; or scrape_run, E-249), recall (true on a '
        'Retry-failed campaign; read by advanceCampaign to bypass the '
        'once-per-day idempotency guard), and E-249: runId, '
        'runCities[{raw,state,city,resolved}], and filters{aiCallState, '
        'aiAttemptsMin, connectStatus, dispositionBucket, disposition}. '
        'Rendered by src/lib/leads/regionSummary.ts.';
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: dialer campaign tables absent';
END;
$do$;

DO $do$
BEGIN
    COMMENT ON COLUMN scraper_run_chunks.city IS
        'E-227. E-249 makes this LOAD-BEARING beyond the scraper: it is the '
        'primary source for the Run Campaign buttons target cities, resolved '
        'through city_aliases -> cities -> states because the audience resolver '
        'matches canonical city buckets EXACTLY. '
        'scraped_dealer_leads.location_city is used ONLY for values that '
        'survive the alias table, with the remainder discarded - it is the '
        'upstream address parse and is 96 percent noise (3,729 distinct values, '
        '150 resolvable, real samples 01 and 09 KANHA NIRMAL). NULL on chunks '
        'created before E-227, which is most historical runs; the button is '
        'disabled with a visible reason in that case rather than guessing.';
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: scraper_run_chunks absent (E-227 not applied)';
END;
$do$;
