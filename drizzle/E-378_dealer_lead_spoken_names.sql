-- =============================================================================
-- E-378 — AI DIALER: THE SHOP NAME THE AGENT SAYS (AI dialer list item 3)
-- =============================================================================
-- WHY.
--   The agent opened every call with the raw listing title: "Bansal Battery
--   House - exide Car Battery | Amaron Car Battery Dealer Saket", "TVS -
--   Dynamic Motors Pvt Ltd". Dealers hang up on a robot reading a Google Maps
--   title. src/lib/ai-dialer/spokenName.ts now shortens it by rule ("Bansal
--   Battery House", "Dynamic Motors") and sends it as {{shop_name_spoken}}.
--
-- WHAT. dealer_lead_spoken_names — a rep's override, one row per lead:
--   lead_id      dealer_leads.id
--   spoken_name  what the agent should say instead of the computed name
--   set_by       users.id of the rep
--   set_at
--   No row = the computed name. Deleting the row goes back to it.
--
-- A new raw-SQL table behind to_regclass (src/lib/ai-dialer/spokenNameStore.ts),
-- NOT mirrored in schema.ts: without it every call gets the computed name and
-- the lead page cannot save an override. Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS dealer_lead_spoken_names (
    lead_id      text         PRIMARY KEY,
    spoken_name  varchar(80)  NOT NULL,
    set_by       text,
    set_at       timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE dealer_lead_spoken_names IS
    'E-378: rep override of the shop name the AI dialer says ({{shop_name_spoken}}); src/lib/ai-dialer/spokenNameStore.ts.';
