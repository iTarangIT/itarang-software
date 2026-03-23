-- Migration: Add bolna_calls table for n8n webhook integration
-- Purpose: Store Bolna call tracking and transcript data

CREATE TABLE IF NOT EXISTS bolna_calls (
    id VARCHAR(255) PRIMARY KEY,  -- Internal ID: BOLNA-YYYYMMDD-SEQ
    bolna_call_id VARCHAR(255) NOT NULL UNIQUE,  -- Bolna's unique call ID
    lead_id VARCHAR(255) REFERENCES leads(id),
    
    -- Call Status
    status VARCHAR(20) DEFAULT 'initiated' NOT NULL,  -- initiated, paused, resumed, completed, failed
    current_phase VARCHAR(100),  -- Current conversation phase (greeting, qualification, etc.)
    
    -- Timestamps
    started_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE,
    
    -- Transcript Management
    transcript_chunk TEXT,  -- Accumulates transcript chunks
    chunk_received_at TIMESTAMP WITH TIME ZONE,
    full_transcript TEXT,  -- Complete transcript from Bolna API
    transcript_fetched_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS bolna_calls_bolna_call_id_idx ON bolna_calls(bolna_call_id);
CREATE INDEX IF NOT EXISTS bolna_calls_lead_id_idx ON bolna_calls(lead_id);
CREATE INDEX IF NOT EXISTS bolna_calls_status_idx ON bolna_calls(status);
CREATE INDEX IF NOT EXISTS bolna_calls_started_at_idx ON bolna_calls(started_at);

-- Comments for documentation
COMMENT ON TABLE bolna_calls IS 'Stores Bolna AI call tracking and transcript data from webhook events';
COMMENT ON COLUMN bolna_calls.bolna_call_id IS 'Unique call ID provided by Bolna API';
COMMENT ON COLUMN bolna_calls.transcript_chunk IS 'Accumulated transcript chunks received during the call';
COMMENT ON COLUMN bolna_calls.full_transcript IS 'Complete transcript fetched from Bolna API after call ends';
