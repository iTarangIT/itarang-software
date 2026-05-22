-- E-119: upload_batches — bulk upload audit + 24h rollback
--
-- BRD §0.4. Every admin CSV upload creates a row here. dealer_leads.upload_batch_id
-- references it for traceability. Rollback sets is_active=false on every lead
-- in the batch (does NOT delete) — preserves the audit trail.

CREATE TABLE IF NOT EXISTS upload_batches (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by text NOT NULL,
  file_name text NOT NULL,
  total_rows integer DEFAULT 0,
  valid_rows integer DEFAULT 0,
  errored_rows integer DEFAULT 0,
  duplicate_rows integer DEFAULT 0,
  routing_to_ai boolean DEFAULT false,
  source_label text,
  status varchar(30) DEFAULT 'pending',
  rollback_window_until timestamptz,
  rolled_back_at timestamptz,
  rolled_back_by text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Admin dashboard "Recent uploads" listing
CREATE INDEX IF NOT EXISTS upload_batches_uploader_created_idx
  ON upload_batches (uploaded_by, created_at DESC);

-- Cron / UI lookup for batches still within rollback window
CREATE INDEX IF NOT EXISTS upload_batches_rollback_pending_idx
  ON upload_batches (rollback_window_until)
  WHERE rolled_back_at IS NULL AND rollback_window_until IS NOT NULL;
