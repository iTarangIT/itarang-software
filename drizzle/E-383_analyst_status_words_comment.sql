-- =============================================================================
-- E-383 — AI ANALYST: SCREEN NAMES IN THE dealer_leads.lead_status COMMENT
--          (14 Nov 2026 — ID 167 item 3, after the 215 wording)
-- =============================================================================
-- WHY.
--   The screens call two stages by new names (ID 215): Commercials_Explained
--   shows as "Quote given", Commercials_Finalised as "Dealer agreed". The stored
--   codes did not change. The Analyst's rules already say so; the agent's table
--   ranker and its one-line table index read the COLUMN COMMENT, so a CEO who
--   types "dealer agreed" should find the column through it too.
--
-- WHAT.
--   Appends the two screen names to the comment E-359 put on
--   dealer_leads.lead_status. Leaves any other (hand-written) comment alone,
--   and does nothing when the comment already names "Quote given".
--
-- Catalog metadata only: no data, nothing for schema.ts to mirror. Idempotent.
-- AFTER APPLYING: press "Refresh tables" on the AI Analyst's iTarang source.
-- =============================================================================

DO $do$
DECLARE
    rel     regclass := to_regclass('public.dealer_leads');
    colnum  smallint;
    current text;
    e359    text := 'Stage of the lead. Converted = onboarding approved (what targets and credit use); Won = the rep marked it won; Lost = lost (lost_reason says why).';
    words   text := ' Screen names: Commercials_Explained shows as ''Quote given'', Commercials_Finalised as ''Dealer agreed''.';
BEGIN
    IF rel IS NULL THEN
        RAISE NOTICE 'E-383: dealer_leads absent, skipping';
        RETURN;
    END IF;
    SELECT attnum INTO colnum FROM pg_attribute
     WHERE attrelid = rel AND attname = 'lead_status' AND attnum > 0 AND NOT attisdropped;
    IF colnum IS NULL THEN
        RAISE NOTICE 'E-383: dealer_leads.lead_status absent, skipping';
        RETURN;
    END IF;

    current := col_description(rel, colnum);
    IF current IS NOT NULL AND position('Quote given' IN current) > 0 THEN
        RAISE NOTICE 'E-383: already applied, skipping';
        RETURN;
    END IF;
    IF current IS NOT NULL AND current <> e359 THEN
        RAISE NOTICE 'E-383: lead_status carries a hand-written comment, left alone';
        RETURN;
    END IF;

    EXECUTE format('COMMENT ON COLUMN public.dealer_leads.lead_status IS %L', e359 || words);
END
$do$;
