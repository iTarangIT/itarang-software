-- E-188 — Human-in-the-loop promotion, and a way to retire a hypothesis.
--
-- Two problems this fixes.
--
-- 1. AN UNVETTED MACHINE-INVENTED TEST COULD RAISE A RED ALERT.
--    The LangGraph agent writes a hypothesis, writes the Python, runs it, and if
--    5% of the book trips it the card says HIGH ALERT — with exactly the same
--    authority as the five hand-coded evaluators a human wrote and reviewed. On
--    database-2 this produced gems like "Ignition Status Risk — 7 of 7 affected"
--    and "High Demand Vehicles — 5 of 7": weak hypotheses that flag most of the
--    portfolio and shout about it.
--
--    An llm-v1 hypothesis is now capped at `warn` until a human promotes it.
--    It can still surface a concern; it cannot declare a crisis on its own.
--
-- 2. THE CATALOGUE GREW FOREVER.
--    Every click of "Re-run analysis" minted 6-8 brand-new hypotheses with new
--    slugs, tested them once, and never looked at them again — the next run
--    invented different ones. The catalogue reached 45 (5 hand-coded + 40 LLM)
--    with only ~8 current, so the page was mostly stale one-shot verdicts and
--    the numbers reshuffled on every click. `retired_at` existed in the schema
--    and was written by nothing.
--
--    The engine now REUSES stored hypotheses (their Python is persisted in
--    test_definition) instead of re-inventing, only proposes new ones below a
--    cap, and retires tests that are persistently broken.
--
-- Additive and idempotent.

ALTER TABLE risk_hypotheses
  ADD COLUMN IF NOT EXISTS promoted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS promoted_by   uuid,
  ADD COLUMN IF NOT EXISTS retire_reason text;

COMMENT ON COLUMN risk_hypotheses.promoted_at IS
  'When a human vetted this hypothesis. Until set, an llm-v1 hypothesis is capped at severity=warn and cannot raise a High Alert. Hand-coded (source=human) hypotheses are promoted by definition.';

COMMENT ON COLUMN risk_hypotheses.retire_reason IS
  'Why this hypothesis was retired. Retired rows keep their history but are no longer run or rendered.';

-- The five hand-coded evaluators were written and reviewed by a human; they are
-- promoted by definition and must keep their ability to raise a High Alert.
UPDATE risk_hypotheses
   SET promoted_at = COALESCE(promoted_at, created_at)
 WHERE source = 'human'
   AND promoted_at IS NULL;

-- Skip retired and unpromoted rows cheaply when loading the catalogue.
CREATE INDEX IF NOT EXISTS risk_hypotheses_active_idx
  ON risk_hypotheses (source) WHERE retired_at IS NULL;
