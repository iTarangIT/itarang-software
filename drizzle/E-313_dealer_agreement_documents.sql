-- E-313 — every file of a manually executed dealer agreement (tracker ID 55).
--
-- An admin can now upload the signed agreement AND more than one audit trail,
-- also after the agreement is complete. Each file is kept (under its own
-- storage key — the canonical signed-agreement.pdf / audit-trail.pdf keys still
-- hold the first of each, so every download route keeps working) with what the
-- system read from it and whether it matched the dealer and Digio.
--
-- DDL: additive + idempotent. One NEW table, no change to any existing one.
-- NOT mirrored in schema.ts: the writer is a raw, fail-tolerant INSERT in the
-- upload route, so an unapplied host still completes the agreement (the files
-- are stored) and only loses the per-file record. Either deploy order is safe.

CREATE TABLE IF NOT EXISTS dealer_agreement_documents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id   text         NOT NULL,
    kind             varchar(30)  NOT NULL,          -- signed_agreement | audit_trail
    file_name        text,
    byte_size        integer,
    storage_bucket   varchar(60)  NOT NULL,
    storage_path     text         NOT NULL,
    file_url         text,
    extracted        jsonb        NOT NULL DEFAULT '{}'::jsonb,
    verdict          varchar(20),                    -- verified | mismatch | unreadable
    reasons          jsonb        NOT NULL DEFAULT '[]'::jsonb,
    mismatch_confirmed_by text,
    mismatch_reason  text,
    uploaded_by      text,
    uploaded_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dealer_agreement_documents_app_idx
    ON dealer_agreement_documents (application_id, uploaded_at DESC);
