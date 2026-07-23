------------------------------------------------------------------------------
-- E-200: nbfc_doc_requests — the NBFC-originated document/KYC request thread.
--
-- Turns the NBFC "Acquire" workspace from a read-only dossier review into an
-- interactive two-way loop. The user's required cycle is:
--
--     NBFC -> Admin -> Dealer -> Customer -> Dealer -> Admin -> NBFC
--
-- The NBFC raises a correction / additional-doc / step-4-extra-items / message
-- request; the Admin reviews and forwards it to the dealer; the dealer collects
-- from the customer; the upload comes back up to the admin, who pushes the
-- finished doc to the NBFC. Status is visible at every hop.
--
-- WHY A WRAPPER (this table) OVER A CHILD (other_document_requests):
--   The actual files already ride on `other_document_requests` + the tokenised
--   /upload-docs page — that machinery already implements the Admin<->Dealer<->
--   Customer legs and we must NOT rebuild it. This wrapper adds only the thread
--   identity + the hop status on top. ONE wrapper row -> MANY child rows
--   (additional-docs and step-4-extra-items are intrinsically multi-item; a
--   single hop-status is only meaningful at the thread level). A `message`
--   request (admin -> NBFC direct, Change 3) has ZERO children.
--
-- WHY TAG COLUMNS ON other_document_requests, NOT A JOIN TABLE:
--   `source DEFAULT 'admin'` means every existing admin-origin row is unchanged
--   and every existing query still works; NBFC-origin children carry
--   `source='nbfc'` + `nbfc_request_id`. "NBFC-originated" becomes a one-clause
--   filter for the admin CaseReview card, with no second write path and no JOIN
--   on every list query. The only behavioural edit elsewhere is a guarded
--   `if (row.nbfc_request_id) recomputeWrapperStatus(...)` in the child review
--   route — admin-origin rows never enter wrapper logic.
--
-- Additive + idempotent. No backfill (there are no NBFC requests yet, and every
-- existing other_document_requests row is correctly 'admin' with a NULL wrapper).
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS nbfc_doc_requests (
  id             varchar(255) PRIMARY KEY,                 -- 'NBFCREQ-YYYYMMDD-SSSS'
  lead_id        varchar(255) NOT NULL,                    -- leads.id (loose FK, like other_document_requests)
  assignment_id  uuid NOT NULL,                            -- nbfc_lead_assignments.id (the acquire binding)
  nbfc_id        integer NOT NULL,                         -- nbfc.id (serial int)
  tenant_id      uuid NOT NULL,                            -- nbfc_tenants.id (session scope)
  request_type   varchar(24) NOT NULL,                     -- 'correction'|'additional_docs'|'step4_extra_items'|'message'
  doc_for        varchar(20) NOT NULL DEFAULT 'primary',   -- 'primary'|'co_borrower'
  target_doc_key varchar(120),                             -- 'aadhaar'|'pan'|'bank'|'rc'... (NULL for additional/message)
  nbfc_comments  text,                                     -- the NBFC's ask / comment box
  admin_notes    text,                                     -- admin annotation before forward
  status         varchar(32) NOT NULL DEFAULT 'nbfc_raised',
  item_count     integer NOT NULL DEFAULT 0,               -- # linked children; cap enforcement (<=10)
  raised_by      uuid NOT NULL,                            -- NBFC actor (resolveActor.user_id)
  reviewed_by    uuid,                                     -- admin who forwarded / pushed
  -- Email "act from mail" (Change 5): a sha256-hashed token minted when the admin
  -- notification email is sent, letting the admin open the confirm page and
  -- forward/push without logging in. Raw token only ever in the email URL.
  act_token_hash       varchar(64),
  act_token_expires_at timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nbfc_doc_requests_lead_status_idx
  ON nbfc_doc_requests (lead_id, status);
CREATE INDEX IF NOT EXISTS nbfc_doc_requests_assignment_idx
  ON nbfc_doc_requests (assignment_id);
CREATE INDEX IF NOT EXISTS nbfc_doc_requests_nbfc_status_idx
  ON nbfc_doc_requests (nbfc_id, status);

COMMENT ON TABLE nbfc_doc_requests IS
  'E-200 — NBFC-originated request thread on the Acquire workspace. One wrapper row -> many other_document_requests children (which carry the files); a request_type=message row has zero children. status is the 7-hop cycle NBFC->Admin->Dealer->Customer->Dealer->Admin->NBFC, derived from child min-state at hops 4-6 and stored denormalised so list views stay one-row.';

COMMENT ON COLUMN nbfc_doc_requests.status IS
  'nbfc_raised -> admin_review -> forwarded_to_dealer -> with_customer -> dealer_review -> admin_review_upload -> pushed_to_nbfc; plus closed (acknowledged) and rejected (admin declined the ask). message rows skip the dealer hops: admin_review -> pushed_to_nbfc -> closed.';

COMMENT ON COLUMN nbfc_doc_requests.item_count IS
  'Number of linked other_document_requests children. For request_type=step4_extra_items this is capped at 10 (enforced in the API; CHECK backstop in E-202).';

-- --- Tag columns on the existing child table (additive, non-breaking) ---
-- Existing admin flow writes source='admin', nbfc_request_id=NULL and is
-- entirely unaffected. other_document_requests exists on every env.
ALTER TABLE other_document_requests
  ADD COLUMN IF NOT EXISTS nbfc_request_id varchar(255);   -- FK-by-convention -> nbfc_doc_requests.id
ALTER TABLE other_document_requests
  ADD COLUMN IF NOT EXISTS source varchar(16) DEFAULT 'admin';   -- 'admin'|'nbfc'

CREATE INDEX IF NOT EXISTS other_document_requests_nbfc_request_idx
  ON other_document_requests (nbfc_request_id);

COMMENT ON COLUMN other_document_requests.nbfc_request_id IS
  'E-200 — when set, this doc row is a child of an nbfc_doc_requests wrapper (NBFC-originated). NULL for the ordinary admin->dealer request flow.';
COMMENT ON COLUMN other_document_requests.source IS
  'E-200 — origin of the request: admin (default, existing flow) | nbfc (created by the admin forward of an nbfc_doc_requests wrapper).';
