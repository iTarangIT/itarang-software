------------------------------------------------------------------------------
-- E-223: scrap vendor onboarding — documents, manual agreement, portal
--        credentials.
--
-- WHAT THIS UNBLOCKS
--   Until now the only way an admin could add a scrap vendor was a 7-field
--   modal (name, GSTIN, email, phone, payment terms, city, state) that wrote
--   the E-186 triple and stopped. No documents, no address, and — despite
--   E-195 having built the vendor login — no login: only the PUBLIC
--   /vendor-onboarding page could create one, and there the vendor chose their
--   own password. So a vendor iTarang invited had a worse account than one who
--   walked in off the street.
--
--   This migration backs the admin onboarding form: three mandatory documents
--   (GSTIN certificate, PAN card, Udyam certificate), an optional manually
--   signed agreement, and a record of the generated-password email we send —
--   the same shape as NBFC activation (E-002).
--
-- WHY scrap_vendor_documents.entity_id IS NULLABLE
--   The documents are picked in the browser BEFORE the vendor exists, so at
--   upload time there is no accounts.id to hang them off. The alternative was
--   to let the client hand a storage key back at submit time, which would make
--   an admin-supplied string a storage path — the exact thing
--   src/lib/buyback/storage.ts refuses to allow ("keys are always
--   SERVER-DERIVED"). Instead the upload inserts an UNCLAIMED row and returns
--   its id; submitting claims it by setting entity_id + claimed_at. Nothing
--   client-supplied is ever a path, and an abandoned form leaves a row that is
--   trivially identifiable (entity_id IS NULL) rather than an untracked object.
--
-- WHY vendor_portal_credentials HAS NO PASSWORD COLUMN
--   Same rule as nbfc_portal_credentials (E-002): the plaintext is emailed and
--   never persisted. What IS worth keeping is whether it was DELIVERED — one
--   row per dispatch attempt, so "did he ever get his login?" is answerable
--   without reading mail logs, and a bounced email is a retryable state rather
--   than a vendor stuck PENDING for reasons nobody recorded.
--
-- BUYBACK-ONLY. scrap_vendors exists on database-1 only; sandbox and
-- production have no buyback tables at all. Every block is guarded so this
-- file is a clean no-op there rather than an error.
--
-- Additive + idempotent. Re-running this file changes nothing.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 1. VENDOR DOCUMENTS
--
--    doc_type is free text, not an enum, per this family's convention (cf.
--    E-202_dealer_type, E-218_expense_buckets, E-220): the vocabulary
--    (GSTIN | PAN | UDYAM | AGREEMENT) lives in src/lib/buyback/vendor-docs.ts
--    and is enforced by zod at the write path. An enum would need a migration
--    the day someone adds a trade licence.
------------------------------------------------------------------------------
DO $do$ BEGIN
  CREATE TABLE IF NOT EXISTS scrap_vendor_documents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL until the onboarding form is submitted — see the header.
    entity_id     VARCHAR(255) REFERENCES accounts(id) ON DELETE CASCADE,
    doc_type      TEXT NOT NULL,
    s3_key        TEXT NOT NULL,
    file_name     TEXT,
    content_type  TEXT,
    uploaded_by   UUID,
    claimed_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip scrap_vendor_documents — accounts not present';
END; $do$;

DO $do$ BEGIN
  CREATE INDEX IF NOT EXISTS scrap_vendor_documents_entity_idx
    ON scrap_vendor_documents (entity_id);

  -- One CURRENT document per type per vendor. Partial, because every unclaimed
  -- row has entity_id NULL and NULLs would otherwise collide on re-upload.
  CREATE UNIQUE INDEX IF NOT EXISTS scrap_vendor_documents_entity_type_unique
    ON scrap_vendor_documents (entity_id, doc_type)
    WHERE entity_id IS NOT NULL;

  -- Abandoned uploads. Indexed so a future sweep of stale unclaimed rows does
  -- not have to scan the table.
  CREATE INDEX IF NOT EXISTS scrap_vendor_documents_unclaimed_idx
    ON scrap_vendor_documents (created_at)
    WHERE entity_id IS NULL;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip scrap_vendor_documents indexes — table not present';
END; $do$;

------------------------------------------------------------------------------
-- 2. VENDOR-SPECIFIC ONBOARDING FIELDS
--
--    On scrap_vendors, not accounts: `accounts` is shared with dealers and
--    OEMs, and none of these three mean anything for them. The registered
--    ADDRESS goes on accounts because those columns (address_line1/2, city,
--    state, pincode) already exist there and were simply never filled in by
--    the vendor write paths.
--
--    agreement_ref / agreement_signed_on describe a MANUALLY signed agreement
--    — a PDF an admin uploads. business_entity_roles.agreement_id stays
--    reserved for the Digio document id (M19); the two are deliberately not
--    the same column, because "we hold a scan" and "eSign completed" are
--    different assurances and conflating them would let the weaker one satisfy
--    a check written for the stronger.
------------------------------------------------------------------------------
DO $do$ BEGIN
  ALTER TABLE scrap_vendors ADD COLUMN IF NOT EXISTS udyam_number TEXT;
  ALTER TABLE scrap_vendors ADD COLUMN IF NOT EXISTS agreement_ref TEXT;
  ALTER TABLE scrap_vendors ADD COLUMN IF NOT EXISTS agreement_signed_on DATE;

  COMMENT ON COLUMN scrap_vendors.udyam_number IS
    'MSME Udyam registration number, e.g. UDYAM-MH-26-0012345. Optional — the certificate itself is mandatory at onboarding, the number is supplementary.';
  COMMENT ON COLUMN scrap_vendors.agreement_ref IS
    'Reference on the MANUALLY signed vendor agreement. Not a Digio document id — that is business_entity_roles.agreement_id (M19).';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip scrap_vendors columns — table not present (no buyback here)';
END; $do$;

------------------------------------------------------------------------------
-- 3. PORTAL CREDENTIALS
--
--    One row per dispatch ATTEMPT, not per vendor: a retry after a bounced
--    email is the normal case this table exists to make visible, and
--    overwriting the failed row would erase the only evidence the first send
--    was tried. The latest row by created_at is the current state.
--
--    dispatch_status: pending | dispatched | credential_dispatch_failed
--    (the same three words nbfc_portal_credentials uses).
------------------------------------------------------------------------------
DO $do$ BEGIN
  CREATE TABLE IF NOT EXISTS vendor_portal_credentials (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id            VARCHAR(255) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    supabase_user_id     UUID NOT NULL,
    dispatch_status      VARCHAR(32) NOT NULL,
    -- The mailer's own sentence. Shown to the admin on the retry button, so it
    -- has to survive the request that produced it.
    last_error           TEXT,
    email_dispatched_at  TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  );
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip vendor_portal_credentials — accounts not present';
END; $do$;

DO $do$ BEGIN
  -- The read is always "latest attempt for this vendor".
  CREATE INDEX IF NOT EXISTS vendor_portal_credentials_entity_idx
    ON vendor_portal_credentials (entity_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS vendor_portal_credentials_status_idx
    ON vendor_portal_credentials (dispatch_status);
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip vendor_portal_credentials indexes — table not present';
END; $do$;
