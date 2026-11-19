-- E-391 — Battery Pool diagram 1, part 2: NBFC routing rules (19 Nov 2026).
--
-- An admin / sales head sets rules by any mix of dealer, customer state +
-- city and product category → one NBFC + loan product. When Step 4 opens (KYC
-- cleared and the E-390 dealer check approved) and a rule matches — the most
-- specific one wins — and its product passes the BRE for the lead, the file is
-- sent to that NBFC automatically: no lender pick. No match → today's Step 4
-- choice, where the older city_default_loan_products pins still narrow it.
--
-- Strictly additive + idempotent.

CREATE TABLE IF NOT EXISTS nbfc_routing_rules (
  id serial PRIMARY KEY,
  dealer_code varchar(255),
  state varchar(100),
  city varchar(100),
  product_category varchar(50),
  nbfc_id integer NOT NULL,
  loan_product_id integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nbfc_routing_rules_scope_chk CHECK (
    coalesce(dealer_code, state, city, product_category) IS NOT NULL
    AND (city IS NULL OR state IS NOT NULL)
  )
);

-- One active rule per scope (case- and blank-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS nbfc_routing_rules_active_scope_uniq
  ON nbfc_routing_rules (
    lower(coalesce(dealer_code, '')),
    lower(coalesce(state, '')),
    lower(coalesce(city, '')),
    lower(coalesce(product_category, ''))
  )
  WHERE is_active;

CREATE INDEX IF NOT EXISTS nbfc_routing_rules_active_idx
  ON nbfc_routing_rules (is_active, id DESC);
