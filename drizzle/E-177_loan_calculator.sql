-- E-177_loan_calculator.sql
-- Dealer-portal Loan Calculator: NBFCs, schemes, per-model caps, component prices,
-- city eligibility, settings, saved quotes — all effective-dated + config-versioned
-- for exact quote reproduction. All tables prefixed calc_ to avoid collision with
-- existing project tables (leads/settings/schemes/nbfcs/...).
--
-- Strictly additive. Idempotent: re-running is a no-op. Money in PAISE.
-- Mirror of the calc_* tables appended to src/lib/db/schema.ts.
-- Guard constraints below are the ones Drizzle cannot express (partial-unique
-- "one current row per key", CHECKs). Do NOT skip them.

------------------------------------------------------------------------------
-- 1. ENUM TYPES
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'calc_engine_variant') THEN
    CREATE TYPE calc_engine_variant AS ENUM ('A', 'B');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'calc_record_status') THEN
    CREATE TYPE calc_record_status AS ENUM ('active', 'disabled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'calc_audit_action') THEN
    CREATE TYPE calc_audit_action AS ENUM ('create', 'update', 'delete');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'calc_coverage_type') THEN
    CREATE TYPE calc_coverage_type AS ENUM ('CITY', 'PAN_INDIA');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'calc_component_kind') THEN
    CREATE TYPE calc_component_kind AS ENUM ('battery', 'charger', 'harness', 'soc', 'iot');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'calc_lead_filter_outcome') THEN
    CREATE TYPE calc_lead_filter_outcome AS ENUM ('qualified', 'stretch_only', 'none');
  END IF;
END $$;

------------------------------------------------------------------------------
-- 2. TABLES
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calc_config_versions (
  id             BIGSERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID NOT NULL,
  note           TEXT,
  change_summary JSONB
);
CREATE INDEX IF NOT EXISTS calc_config_versions_created_at_idx ON calc_config_versions (created_at);

CREATE TABLE IF NOT EXISTS calc_audit_log (
  id                 BIGSERIAL PRIMARY KEY,
  at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id           UUID NOT NULL,
  action             calc_audit_action NOT NULL,
  entity             TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  before             JSONB,
  after              JSONB,
  config_version_id  BIGINT REFERENCES calc_config_versions (id)
);
CREATE INDEX IF NOT EXISTS calc_audit_log_entity_idx ON calc_audit_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS calc_audit_log_at_idx ON calc_audit_log (at);
CREATE INDEX IF NOT EXISTS calc_audit_log_actor_idx ON calc_audit_log (actor_id);

CREATE TABLE IF NOT EXISTS calc_settings (
  id                            BIGSERIAL PRIMARY KEY,
  dealer_margin_paise           BIGINT NOT NULL,
  near_best_window_pct          NUMERIC(5,2) NOT NULL DEFAULT 25,
  expected_emi_filter_required  BOOLEAN NOT NULL DEFAULT false,
  upfront_filter_required       BOOLEAN NOT NULL DEFAULT false,
  disclaimer_text               TEXT NOT NULL,
  card_footer_disclaimer        TEXT NOT NULL,
  contact_phone                 TEXT NOT NULL,
  contact_email                 TEXT NOT NULL,
  contact_whatsapp              TEXT NOT NULL,
  valid_from                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to                      TIMESTAMPTZ,
  config_version_id             BIGINT NOT NULL REFERENCES calc_config_versions (id)
);
CREATE INDEX IF NOT EXISTS calc_settings_valid_to_idx ON calc_settings (valid_to);

CREATE TABLE IF NOT EXISTS calc_battery_models (
  id           SERIAL PRIMARY KEY,
  sku_code     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  voltage      NUMERIC(5,1),
  capacity_ah  INTEGER,
  charger_sku  TEXT,
  status       calc_record_status NOT NULL DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS calc_battery_models_sku_uq ON calc_battery_models (sku_code);

CREATE TABLE IF NOT EXISTS calc_component_prices (
  id                BIGSERIAL PRIMARY KEY,
  model_id          INTEGER NOT NULL REFERENCES calc_battery_models (id),
  component         calc_component_kind NOT NULL,
  amount_paise      BIGINT NOT NULL,
  gst_multiplier    NUMERIC(5,4) NOT NULL,
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to          TIMESTAMPTZ,
  config_version_id BIGINT NOT NULL REFERENCES calc_config_versions (id)
);
CREATE INDEX IF NOT EXISTS calc_component_prices_lookup_idx ON calc_component_prices (model_id, component, valid_to);

CREATE TABLE IF NOT EXISTS calc_dealer_margin_overrides (
  id                  BIGSERIAL PRIMARY KEY,
  model_id            INTEGER NOT NULL REFERENCES calc_battery_models (id),
  dealer_margin_paise BIGINT NOT NULL,
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to            TIMESTAMPTZ,
  config_version_id   BIGINT NOT NULL REFERENCES calc_config_versions (id)
);
CREATE INDEX IF NOT EXISTS calc_dealer_margin_overrides_lookup_idx ON calc_dealer_margin_overrides (model_id, valid_to);

CREATE TABLE IF NOT EXISTS calc_nbfcs (
  id                          SERIAL PRIMARY KEY,
  nbfc_code                   TEXT NOT NULL,
  name                        TEXT NOT NULL,
  variant                     calc_engine_variant NOT NULL,
  max_loan_cap_paise          BIGINT,
  flat_interest_rate          NUMERIC(10,7),
  file_fee_paise              BIGINT NOT NULL,
  default_processing_fee_paise BIGINT NOT NULL,
  status                      calc_record_status NOT NULL DEFAULT 'active',
  valid_from                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to                    TIMESTAMPTZ,
  config_version_id           BIGINT NOT NULL REFERENCES calc_config_versions (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS calc_nbfcs_name_uq ON calc_nbfcs (name, valid_to);
CREATE INDEX IF NOT EXISTS calc_nbfcs_status_idx ON calc_nbfcs (status, valid_to);

CREATE TABLE IF NOT EXISTS calc_nbfc_model_caps (
  id                 BIGSERIAL PRIMARY KEY,
  nbfc_id            INTEGER NOT NULL REFERENCES calc_nbfcs (id),
  model_id           INTEGER NOT NULL REFERENCES calc_battery_models (id),
  max_loan_cap_paise BIGINT NOT NULL,
  valid_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to           TIMESTAMPTZ,
  config_version_id  BIGINT NOT NULL REFERENCES calc_config_versions (id)
);
CREATE INDEX IF NOT EXISTS calc_nbfc_model_caps_lookup_idx ON calc_nbfc_model_caps (nbfc_id, model_id, valid_to);

CREATE TABLE IF NOT EXISTS calc_schemes (
  id                    BIGSERIAL PRIMARY KEY,
  nbfc_id               INTEGER NOT NULL REFERENCES calc_nbfcs (id),
  tenure_months         INTEGER NOT NULL,
  advance_months        INTEGER NOT NULL,
  code                  TEXT NOT NULL,
  applied_interest_rate NUMERIC(10,7),
  processing_fee_paise  BIGINT,
  advance_interest_rate NUMERIC(10,7),
  status                calc_record_status NOT NULL DEFAULT 'active',
  valid_from            TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to              TIMESTAMPTZ,
  config_version_id     BIGINT NOT NULL REFERENCES calc_config_versions (id)
);
CREATE INDEX IF NOT EXISTS calc_schemes_nbfc_idx ON calc_schemes (nbfc_id, status, valid_to);
CREATE INDEX IF NOT EXISTS calc_schemes_code_idx ON calc_schemes (nbfc_id, code);

CREATE TABLE IF NOT EXISTS calc_nbfc_coverage (
  id                BIGSERIAL PRIMARY KEY,
  nbfc_id           INTEGER NOT NULL REFERENCES calc_nbfcs (id),
  coverage_type     calc_coverage_type NOT NULL,
  city_normalized   TEXT,
  state_code        TEXT,
  city_display      TEXT,
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to          TIMESTAMPTZ,
  config_version_id BIGINT NOT NULL REFERENCES calc_config_versions (id)
);
CREATE INDEX IF NOT EXISTS calc_nbfc_coverage_city_idx ON calc_nbfc_coverage (city_normalized, valid_to);
CREATE INDEX IF NOT EXISTS calc_nbfc_coverage_nbfc_idx ON calc_nbfc_coverage (nbfc_id, valid_to);

CREATE TABLE IF NOT EXISTS calc_leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  dealer_id             VARCHAR(255),
  customer_name         TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  pincode               TEXT,
  city                  TEXT,
  state                 TEXT,
  expected_emi_paise    BIGINT,
  upfront_ability_paise BIGINT,
  tenure_months         INTEGER,
  model_id              INTEGER REFERENCES calc_battery_models (id),
  filter_outcome        calc_lead_filter_outcome,
  config_version_id     BIGINT REFERENCES calc_config_versions (id),
  result_snapshot       JSONB,
  crm_lead_id           TEXT,
  crm_synced_at         TIMESTAMPTZ,
  idempotency_key       TEXT
);
CREATE INDEX IF NOT EXISTS calc_leads_phone_idx ON calc_leads (phone);
CREATE INDEX IF NOT EXISTS calc_leads_created_at_idx ON calc_leads (created_at);
CREATE INDEX IF NOT EXISTS calc_leads_dealer_idx ON calc_leads (dealer_id);

------------------------------------------------------------------------------
-- 3. GUARDS: one CURRENT row per logical key (partial unique on valid_to IS NULL).
--    Postgres treats NULLs as distinct, so a plain unique index would allow many
--    "current" rows and the engine could resolve an ambiguous price/cap/scheme.
------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS calc_nbfcs_current_code_uq
  ON calc_nbfcs (nbfc_code) WHERE valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS calc_settings_current_uq
  ON calc_settings ((true)) WHERE valid_to IS NULL;  -- only one current settings row

CREATE UNIQUE INDEX IF NOT EXISTS calc_component_prices_current_uq
  ON calc_component_prices (model_id, component) WHERE valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS calc_schemes_current_uq
  ON calc_schemes (nbfc_id, code) WHERE valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS calc_nbfc_model_caps_current_uq
  ON calc_nbfc_model_caps (nbfc_id, model_id) WHERE valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS calc_dealer_margin_overrides_current_uq
  ON calc_dealer_margin_overrides (model_id) WHERE valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS calc_nbfc_coverage_current_city_uq
  ON calc_nbfc_coverage (nbfc_id, city_normalized)
  WHERE valid_to IS NULL AND coverage_type = 'CITY';

CREATE UNIQUE INDEX IF NOT EXISTS calc_nbfc_coverage_current_panindia_uq
  ON calc_nbfc_coverage (nbfc_id)
  WHERE valid_to IS NULL AND coverage_type = 'PAN_INDIA';

------------------------------------------------------------------------------
-- 4. GUARDS: CHECK constraints (shape, agreement, dates, money, variant rate)
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_advance_lt_tenure') THEN
    ALTER TABLE calc_schemes ADD CONSTRAINT calc_advance_lt_tenure CHECK (advance_months < tenure_months);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_code_matches_tenure_advance') THEN
    ALTER TABLE calc_schemes ADD CONSTRAINT calc_code_matches_tenure_advance
      CHECK (code = tenure_months::text || 'by' || advance_months::text);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_coverage_shape_chk') THEN
    ALTER TABLE calc_nbfc_coverage ADD CONSTRAINT calc_coverage_shape_chk CHECK (
      (coverage_type = 'PAN_INDIA' AND city_normalized IS NULL AND state_code IS NULL)
      OR
      (coverage_type = 'CITY' AND city_normalized IS NOT NULL AND state_code IS NOT NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_schemes_dates_chk') THEN
    ALTER TABLE calc_schemes ADD CONSTRAINT calc_schemes_dates_chk CHECK (valid_to IS NULL OR valid_to > valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_cp_dates_chk') THEN
    ALTER TABLE calc_component_prices ADD CONSTRAINT calc_cp_dates_chk CHECK (valid_to IS NULL OR valid_to > valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_caps_dates_chk') THEN
    ALTER TABLE calc_nbfc_model_caps ADD CONSTRAINT calc_caps_dates_chk CHECK (valid_to IS NULL OR valid_to > valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_nbfcs_dates_chk') THEN
    ALTER TABLE calc_nbfcs ADD CONSTRAINT calc_nbfcs_dates_chk CHECK (valid_to IS NULL OR valid_to > valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_cov_dates_chk') THEN
    ALTER TABLE calc_nbfc_coverage ADD CONSTRAINT calc_cov_dates_chk CHECK (valid_to IS NULL OR valid_to > valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_dmo_dates_chk') THEN
    ALTER TABLE calc_dealer_margin_overrides ADD CONSTRAINT calc_dmo_dates_chk CHECK (valid_to IS NULL OR valid_to > valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_settings_dates_chk') THEN
    ALTER TABLE calc_settings ADD CONSTRAINT calc_settings_dates_chk CHECK (valid_to IS NULL OR valid_to > valid_from);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_cp_nonneg') THEN
    ALTER TABLE calc_component_prices ADD CONSTRAINT calc_cp_nonneg CHECK (amount_paise >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_caps_nonneg') THEN
    ALTER TABLE calc_nbfc_model_caps ADD CONSTRAINT calc_caps_nonneg CHECK (max_loan_cap_paise >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_proc_nonneg') THEN
    ALTER TABLE calc_schemes ADD CONSTRAINT calc_proc_nonneg CHECK (processing_fee_paise IS NULL OR processing_fee_paise >= 0);
  END IF;

  -- An ACTIVE scheme must carry an applied rate (Variant B correctness backstop).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_active_scheme_has_rate') THEN
    ALTER TABLE calc_schemes ADD CONSTRAINT calc_active_scheme_has_rate
      CHECK (status <> 'active' OR applied_interest_rate IS NOT NULL);
  END IF;
END $$;

-- NBFC variant integrity (Variant A needs flat cap + flat rate) is enforced at
-- admin-publish because nullability legitimately differs by variant.
