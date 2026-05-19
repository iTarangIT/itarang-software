-- E-116: dealer_lead_commercials — versioned quotes / commercial terms
--
-- BRD §0.10. One row per commercial event (brochure share, quote, revision,
-- final terms). is_current = true on exactly one row per lead at any time.
-- UNIQUE (dealer_lead_id, version_no) catches the rare double-tab race —
-- single-owner rule handles the rest.
--
-- final_price is the hard-validation field: Commercials_Finalised AND Mark
-- Converted require final_price IS NOT NULL on the is_current row.

CREATE TABLE IF NOT EXISTS dealer_lead_commercials (
  commercial_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_lead_id text NOT NULL,
  version_no integer NOT NULL,
  is_current boolean DEFAULT false,
  event_type varchar(30) NOT NULL,
  price_quoted numeric(14, 2),
  quote_document_url text,
  brochure_url text,
  brochure_sent_at timestamptz,
  credit_terms text,
  delivery_terms text,
  warranty_terms text,
  final_price numeric(14, 2),
  payment_method varchar(20),
  deal_notes text,
  notes text,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  withdrawn_at timestamptz
);

-- Per-lead version monotonicity (BRD §0.10 concurrency note)
CREATE UNIQUE INDEX IF NOT EXISTS dealer_lead_commercials_lead_version_uniq
  ON dealer_lead_commercials (dealer_lead_id, version_no);

-- Drives the versioning view (newest first)
CREATE INDEX IF NOT EXISTS dealer_lead_commercials_lead_version_desc_idx
  ON dealer_lead_commercials (dealer_lead_id, version_no DESC);

-- Fast lookup of current row when validating Commercials_Finalised / Converted
CREATE INDEX IF NOT EXISTS dealer_lead_commercials_current_idx
  ON dealer_lead_commercials (dealer_lead_id)
  WHERE is_current = true;
