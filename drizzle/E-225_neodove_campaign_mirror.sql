-- E-225 — Mirror of a NeoDove campaign's own configuration.
--
-- WHY THIS IS A RECORD AND NOT A CONTROL SURFACE.
-- NeoDove exposes no campaign-creation and no read API (see
-- docs/neodove-contract.md). Their Create Campaign form — Pipeline, managing
-- user, agents, lead distribution — lives entirely inside their UI and cannot
-- be driven or fetched from here. So this column stores what a human has
-- observed about the NeoDove campaign, purely so a sales_head can see who is
-- working a campaign without opening NeoDove.
--
-- It is DESCRIPTIVE. Writing to it changes nothing in NeoDove, and the UI says
-- so on every field. Anyone tempted to make these authoritative should first
-- re-read why `push_endpoint_ref` stores an env var NAME: this integration has
-- already been bitten once by state that looked configured and was not.
--
-- WHY ONE jsonb COLUMN RATHER THAN FOUR TYPED COLUMNS.
-- These fields mirror a third-party form we do not control and cannot version.
-- NeoDove adding a field should be a UI change here, not another migration.
-- Nothing joins, filters or aggregates on this data — it is rendered and
-- nothing else — so the usual argument for typed columns does not apply.
--
-- Shape (all keys optional):
--   {
--     "pipeline":         "Sales",
--     "managedBy":        "Chirag Garg",
--     "agents":           ["Kapil", "NIDHI PATHAK"],
--     "leadDistribution": "on_demand",
--     "observedAt":       "2026-08-03T12:10:00.000Z"
--   }
--
-- Agents are free text on purpose. There is no API to fetch NeoDove's user
-- list, so any dropdown would be a hand-maintained copy that goes stale
-- silently the moment somebody joins or leaves — a stale list that LOOKS
-- authoritative is worse than a typed name that obviously is not.
--
-- Idempotent and strictly additive, per CLAUDE.md.

ALTER TABLE neodove_campaigns
    ADD COLUMN IF NOT EXISTS mirror_config jsonb;

COMMENT ON COLUMN neodove_campaigns.mirror_config IS
    'Human-recorded mirror of the NeoDove campaign''s own settings (pipeline, manager, agents, lead distribution). DESCRIPTIVE ONLY - NeoDove has no campaign API, so writing this changes nothing on their side.';
