-- Migration: SM Workflow + Loan Offers
-- Run this against your Supabase PostgreSQL database

-- 1. Add SM workflow columns to leads table
ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS sm_review_status VARCHAR(30) DEFAULT 'not_submitted',
    ADD COLUMN IF NOT EXISTS submitted_to_sm_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sm_assigned_to UUID REFERENCES users(id);

-- 2. Add upload token columns to other_document_requests
ALTER TABLE other_document_requests
    ADD COLUMN IF NOT EXISTS upload_token VARCHAR(255),
    ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

-- 3. Create loan_offers table
CREATE TABLE IF NOT EXISTS loan_offers (
    id              VARCHAR(255) PRIMARY KEY,
    lead_id         VARCHAR(255) NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    financier_name  TEXT NOT NULL,
    loan_amount     DECIMAL(12,2) NOT NULL,
    interest_rate   DECIMAL(5,2) NOT NULL,
    tenure_months   INTEGER NOT NULL,
    emi             DECIMAL(10,2) NOT NULL,
    processing_fee  DECIMAL(10,2),
    notes           TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS loan_offers_lead_id_idx ON loan_offers(lead_id);

COMMENT ON COLUMN leads.sm_review_status IS 'not_submitted | pending_sm_review | under_review | docs_verified | options_ready | option_booked';
COMMENT ON COLUMN loan_offers.status IS 'pending | offered | selected | booked';
