------------------------------------------------------------------------------
-- E-239: NBFC → Dealer DIRECT document request + two-way message thread.
--
-- WHAT THIS ADDS, AND WHY.
--
-- E-200 built the NBFC document-request loop as a strictly admin-gated cycle:
-- NBFC → Admin → Dealer → Customer → Dealer → Admin → NBFC. Every request is
-- born 'nbfc_raised' and NOTHING reaches the dealer until an admin opens the
-- lead and clicks "Forward to dealer". Even then the dealer sees a generic
-- `other_document_requests` row — /api/kyc/[leadId]/requested-docs projects
-- neither `source` nor `nbfc_request_id` — so the NBFC's own words and identity
-- never arrive. In practice the loop stalls on the admin, and the lender's
-- actual question ("send me the last 6 months of the current account, not the
-- savings one") is lost in translation.
--
-- This file adds a SECOND channel alongside that one. The admin-gated path is
-- untouched: same buttons, same statuses, same forward/push routes. A wrapper
-- flagged `dealer_direct` skips the admin's forward click and is visible to the
-- dealer the moment it is raised — the admin still sees the request and every
-- message in it on the KYC review screen, and is still notified on both legs.
-- The admin stops being a BLOCKER, not an observer.
--
--   1. nbfc_doc_requests.dealer_direct — marks a wrapper that bypassed the gate.
--   2. nbfc_doc_request_messages       — the NBFC ⇄ Dealer conversation.
--
-- WHY A MESSAGES TABLE RATHER THAN MORE COLUMNS ON THE WRAPPER. The wrapper has
-- exactly three text surfaces — `nbfc_comments`, `admin_notes` and E-210's
-- `attachments` — and each holds ONE value. A dealer reply has no home at all,
-- and a second round of either side has nowhere to go: the NBFC asks, the dealer
-- sends the wrong statement, the NBFC clarifies, the dealer resends. Writing
-- that into `nbfc_comments` would overwrite the question the reply answers,
-- which is exactly what a disputed sanction turns on. Same reasoning, and the
-- same shape, as E-238's `nbfc_offer_negotiations` — one row per thing one party
-- said at one moment, append-only, ordered.
--
-- WHY NO CHILDREN. A direct request creates NO `other_document_requests` rows.
-- Those exist to drive the tokenised /upload-docs machinery the ADMIN forwards
-- with; here the dealer is already authenticated in the portal and answers from
-- the Step-4 pre-sanction card, so the files ride on the message row and are
-- ALSO appended to `product_selections.pre_sanction_doc_urls` (E-208), which the
-- NBFC dossier and admin product review already read. `recomputeWrapperStatus`
-- must therefore early-return on these wrappers — it projects status from child
-- min-state and a childless wrapper would be pinned at its current value.
--
-- NO NEW STATUSES OR REQUEST TYPES ARE NEEDED, so the E-202 CHECK constraints
-- are NOT touched. A direct request is `request_type = 'step4_extra_items'`
-- (already permitted, and semantically exactly this) and walks
-- 'forwarded_to_dealer' → 'pushed_to_nbfc' → 'closed', all three already in the
-- status CHECK. The NBFC's existing "Acknowledge & close" button therefore works
-- on a direct thread with no UI state machine changes.
--
-- No FK on request_id and no CHECK on `party`, per the nbfc_* family convention
-- (E-202/E-218/E-226/E-231/E-232/E-233/E-238) — the vocabulary is enforced in
-- the route layer and recorded in COMMENT ON COLUMN below.
--
-- REQUIRED — this one does not degrade. `nbfc_doc_requests` IS mirrored in
-- schema.ts and `listThreadForLead` does a bare db.select().from(nbfcDocRequests);
-- Drizzle names every column of a mirrored table in its generated SQL, so on a
-- database without this file the NBFC Acquire request thread AND the admin
-- "NBFC KYC Verification" card both fail on their first read with
-- `column "dealer_direct" does not exist`. Apply before deploying the code.
--
-- Strictly additive and idempotent — safe to re-run. Guarded so it is a reported
-- no-op where E-200 has not landed.
-- Apply with: node scripts/apply-e239.mjs
------------------------------------------------------------------------------

-- 1. The direct-channel flag on the E-200 wrapper. -----------------------------
DO $do$ BEGIN
  ALTER TABLE nbfc_doc_requests
    ADD COLUMN IF NOT EXISTS dealer_direct boolean NOT NULL DEFAULT false;
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
END; $do$;

DO $do$ BEGIN
  COMMENT ON COLUMN nbfc_doc_requests.dealer_direct IS
    'E-239. TRUE = the NBFC sent this straight to the dealer, skipping the admin forward gate. Such a wrapper has NO other_document_requests children — the files ride on nbfc_doc_request_messages.attachments — so recomputeWrapperStatus() must early-return on it. The admin still sees it, and is still notified, on both legs.';
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing — skip comment';
  WHEN undefined_column THEN RAISE NOTICE 'dealer_direct missing — skip comment';
END; $do$;

-- 2. The NBFC ⇄ Dealer conversation. -------------------------------------------
CREATE TABLE IF NOT EXISTS nbfc_doc_request_messages (
  id              varchar(255) PRIMARY KEY,          -- 'NBFCMSG-YYYYMMDD-SSSS'
  request_id      varchar(255) NOT NULL,             -- nbfc_doc_requests.id
  lead_id         varchar(255) NOT NULL,
  party           varchar(16)  NOT NULL,             -- 'nbfc' | 'dealer' | 'admin'
  author_user_id  uuid,
  message         text,
  attachments     jsonb DEFAULT '[]'::jsonb,         -- [{ url, name, type, size }]
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nbfc_doc_request_messages_request_created_idx
  ON nbfc_doc_request_messages (request_id, created_at);

CREATE INDEX IF NOT EXISTS nbfc_doc_request_messages_lead_idx
  ON nbfc_doc_request_messages (lead_id);

COMMENT ON TABLE nbfc_doc_request_messages IS
  'E-239. Append-only NBFC ⇄ Dealer conversation hanging off an nbfc_doc_requests wrapper. One row per thing one party said at one moment, with any files attached to it. Exists because the wrapper holds exactly one nbfc_comments and one admin_notes, so a dealer reply — or a second round from either side — has nowhere to live without overwriting the question it answers. Same shape as E-238 nbfc_offer_negotiations.';

COMMENT ON COLUMN nbfc_doc_request_messages.party IS
  'Who spoke: nbfc | dealer | admin. No CHECK constraint, per the nbfc_* family convention (cf. E-238 nbfc_offer_negotiations.party) — enforced in the route layer.';

COMMENT ON COLUMN nbfc_doc_request_messages.attachments IS
  'Files sent with this message: [{ url, name, type, size }]. A dealer reply''s attachments are ALSO appended to product_selections.pre_sanction_doc_urls (E-208) so they surface in the NBFC dossier and admin product review — but the copy HERE is canonical, because that bucket is capped at 10 items and the cap must never block a reply.';

COMMENT ON COLUMN nbfc_doc_request_messages.request_id IS
  'The nbfc_doc_requests wrapper this belongs to. No FK, per the nbfc_* family convention.';
