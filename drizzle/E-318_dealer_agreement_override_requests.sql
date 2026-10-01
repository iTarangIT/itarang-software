-- E-318 — second approver for a manually executed dealer agreement that does
-- not verify (tracker ID 55, review of 30 Sep 2026).
--
-- Until now the person uploading could save documents the system had flagged
-- as a mismatch by typing any 5-character reason. Now a mismatch is only ever
-- REQUESTED by the uploader: the files are stored, the agreement status does
-- not move, and a different Sales Head / CEO approves or rejects the request.
--
--   dealer_agreement_override_requests   one row per request. At most one
--       pending request per application (partial unique index), and the
--       decision can never be made by the requester (CHECK) — both are
--       guarantees of the database, not only of the route.
--   dealer_agreement_documents (E-313)   + status and override_request_id, so
--       each uploaded file says whether it is on record, waiting, or refused.
--       Existing rows become 'accepted' — they were all saved under the old
--       rule and are already what the agreement shows.
--
-- DDL: additive + idempotent. Mirrored in schema.ts (both tables). Only the
-- manual-upload routes read them: on a host without this migration those
-- routes answer 503 "migration E-318 is not applied" and nothing else changes.
-- Re-run = no-op.

CREATE TABLE IF NOT EXISTS dealer_agreement_override_requests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id    text         NOT NULL,
    status            varchar(20)  NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | withdrawn
    -- true = the agreement was already complete; approval only adds the files.
    add_only          boolean      NOT NULL DEFAULT false,
    -- The Digio document the upload was made against (NULL for a paper
    -- agreement). If the agreement is re-initiated before the decision, the
    -- request no longer applies and approval is refused.
    provider_document_id text,
    verdict           varchar(20)  NOT NULL,                    -- mismatch | unreadable
    reasons           jsonb        NOT NULL DEFAULT '[]'::jsonb,
    -- What the system read: { signedOn, documentId, referenceNumber, signers[] }.
    read_values       jsonb        NOT NULL DEFAULT '{}'::jsonb,
    -- What the uploader typed, kept apart from what was read.
    typed_signed_on   date,
    typed_ref         text,
    request_reason    text         NOT NULL,
    requested_by      text         NOT NULL,
    requested_at      timestamptz  NOT NULL DEFAULT now(),
    decided_by        text,
    decided_at        timestamptz,
    decision_note     text,
    CONSTRAINT dealer_agreement_override_status_chk
        CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    -- The two-person rule: approve / reject is never the requester's own.
    CONSTRAINT dealer_agreement_override_second_person_chk
        CHECK (status IN ('pending', 'withdrawn') OR (decided_by IS NOT NULL AND decided_by <> requested_by))
);

CREATE INDEX IF NOT EXISTS dealer_agreement_override_requests_app_idx
    ON dealer_agreement_override_requests (application_id, requested_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS dealer_agreement_override_one_pending_idx
    ON dealer_agreement_override_requests (application_id)
    WHERE status = 'pending';

DO $do$
BEGIN
    ALTER TABLE dealer_agreement_documents
        ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'accepted',  -- accepted | pending_approval | rejected
        ADD COLUMN IF NOT EXISTS override_request_id uuid;

    CREATE INDEX IF NOT EXISTS dealer_agreement_documents_override_idx
        ON dealer_agreement_documents (override_request_id)
        WHERE override_request_id IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-318: dealer_agreement_documents missing (apply E-313 first) — skip';
END;
$do$;
