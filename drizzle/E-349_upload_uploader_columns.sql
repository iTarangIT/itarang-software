-- =============================================================================
-- E-349 — WHO UPLOADED A CO-BORROWER FILE OR A REQUESTED DOCUMENT (tracker ID 166)
-- =============================================================================
-- WHY. The file rule decided 10 Oct says a dealer opens only the files it
-- uploaded itself on its customer's application — not what the customer sent
-- through the public upload link, or what Admin or the NBFC added. kyc_documents
-- already records its uploader (uploaded_by); co_borrower_documents and
-- other_document_requests did not, so the rule could not be enforced there.
--
-- WHAT. Two nullable columns on each table:
--   uploaded_by    uuid         users.id of the logged-in person (or the dealer
--                               login behind a WhatsApp upload); NULL for a
--                               customer upload through the public link
--   upload_source  varchar(16)  'portal' | 'public_link' | 'whatsapp'
-- Stamped after the file is saved by src/lib/storage/uploaderStamp.ts (raw SQL,
-- a failure is logged, never blocks the upload). Read by the file opener
-- (src/lib/storage/fileAuthz.ts) through to_jsonb, so code on a DB without
-- this migration keeps the old behaviour. Rows with both columns NULL (every
-- file uploaded before this) also keep the old behaviour: the dealer of the
-- lead opens them.
--
-- NOT mirrored in schema.ts on purpose: these tables are written by Drizzle
-- INSERTs on the dealer's upload path, and Drizzle lists every schema column
-- in an INSERT — mirroring before the migration is applied everywhere would
-- break every KYC upload with "column does not exist".
--
-- Additive + idempotent. Re-running is a no-op.
-- =============================================================================

DO $do$ BEGIN
    ALTER TABLE co_borrower_documents ADD COLUMN IF NOT EXISTS uploaded_by uuid;
    ALTER TABLE co_borrower_documents ADD COLUMN IF NOT EXISTS upload_source varchar(16);
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip: co_borrower_documents does not exist';
END; $do$;

DO $do$ BEGIN
    ALTER TABLE other_document_requests ADD COLUMN IF NOT EXISTS uploaded_by uuid;
    ALTER TABLE other_document_requests ADD COLUMN IF NOT EXISTS upload_source varchar(16);
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip: other_document_requests does not exist';
END; $do$;
