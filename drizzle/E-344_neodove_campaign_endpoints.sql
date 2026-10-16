-- =============================================================================
-- E-344 — NEODOVE CAMPAIGN ENDPOINTS STORED ENCRYPTED (A32, 13 Oct call)
-- =============================================================================
-- Requires E-224 (neodove_campaigns).
--
-- WHY. NeoDove has no API key: a campaign's "Custom Integration" endpoint URL
-- IS the credential. It lived only in env vars (neodove_campaigns.
-- push_endpoint_ref = the var's NAME), so every new campaign needed a
-- developer to add a key and restart the server. Decision (proposed answer,
-- 13 Oct call): keep the URL in the database, encrypted, entered by Admin on a
-- write-only form that never shows it back.
--
-- WHAT. One row per (campaign, kind). The URL is AES-256-GCM sealed by the app
-- (src/lib/security/secretBox.ts; key APP_SECRETS_ENC_KEY, else the NBFC vault
-- key), with the AAD "neodove:<campaign_id>:<kind>" so a ciphertext cannot be
-- moved to another campaign. last4 is the only part of the URL ever shown. A
-- campaign whose endpoint is stored here has push_endpoint_ref = 'DB'; env-var
-- refs keep working exactly as before.
--
-- NOT mirrored in schema.ts (raw SQL behind a to_regclass probe in
-- src/lib/neodove/endpointStore.ts): without this table, campaigns keep using
-- env-var endpoints and the form says the store is not set up.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS neodove_campaign_endpoints (
    campaign_id  text        NOT NULL,
    kind         varchar(10) NOT NULL CHECK (kind IN ('push', 'update')),
    ciphertext   text        NOT NULL,
    iv           text        NOT NULL,
    tag          text        NOT NULL,
    last4        varchar(8)  NOT NULL,
    updated_by   text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, kind)
);

COMMENT ON TABLE neodove_campaign_endpoints IS
    'E-344 (A32) — NeoDove Custom Integration endpoint URLs, AES-256-GCM sealed by the app; never returned to a browser. push_endpoint_ref = ''DB'' points a campaign here.';
