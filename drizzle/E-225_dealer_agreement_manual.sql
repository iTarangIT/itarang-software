------------------------------------------------------------------------------
-- E-225: manually signed dealer agreements (Scrap / New+Scrap dealers).
--
-- WHAT THIS UNBLOCKS
--   E-202 classified every dealer as 'new' | 'scrap' | 'both' and said, in its
--   own header, that "the per-type agreement templates and per-type dashboards
--   are deliberately a later change". This is that change, for the agreement
--   half.
--
--   Only NEW battery dealers have a drafted agreement to generate, so only they
--   go through Digio. Scrap and New+Scrap dealers sign on paper and an admin
--   uploads the scan. That path half-existed already — upload-signed-agreement
--   has completed a stalled e-sign since day one — but it was gated on a Digio
--   provider_document_id and had nowhere to record the two facts that make a
--   paper agreement auditable: WHICH document it is, and WHEN it was signed.
--
-- WHY agreement_ref IS NOT provider_document_id
--   Same rule E-223 set for scrap vendors: "we hold a scan" and "eSign
--   completed" are different assurances, and sharing one column would let the
--   weaker satisfy a check written for the stronger. provider_document_id stays
--   exclusively a Digio id — code that asserts an agreement was e-signed keeps
--   asserting exactly that. agreement_mode is the discriminator; nothing has to
--   infer intent from which columns happen to be NULL.
--
-- WHY NO CHANGE TO agreement_status
--   It is varchar(50) with no CHECK and no enum (schema.ts:2809), so the manual
--   path reuses the existing terminal value 'completed'. A separate
--   'manually_uploaded' status would have to be taught to every one of the ~6
--   call sites that compare that column to a string literal (approve/route.ts,
--   initiate-agreement's canInitiateStatuses, lib/agreement/status.ts,
--   AgreementBadge, agreement-tracking), and every one we missed would treat a
--   fully executed agreement as incomplete. Mode and status are orthogonal:
--   HOW it was signed, and WHETHER it is done.
--
-- NOT REQUIRED for the app to run, but required for it to be correct: Drizzle
-- names all three columns in every dealer_onboarding_applications INSERT, so an
-- unapplied environment 500s the onboarding autosave/submit path with "column
-- agreement_mode does not exist" — the same failure mode E-202 documents.
--
-- Additive + idempotent. Re-running this file changes nothing.
------------------------------------------------------------------------------

ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS agreement_mode varchar(16);

ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS agreement_ref text;

ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS agreement_signed_on date;

COMMENT ON COLUMN dealer_onboarding_applications.agreement_mode IS
  'E-225 — how the agreement is executed: esign (Digio, new-battery dealers) | manual (admin uploads a signed scan, scrap / new+scrap dealers). Free text, no CHECK; vocabulary in src/lib/dealer/dealer-capabilities.ts. NULL on rows that predate E-225.';
COMMENT ON COLUMN dealer_onboarding_applications.agreement_ref IS
  'E-225 — reference printed on a MANUALLY signed agreement. Never a Digio document id: that is provider_document_id, and the two assurances must not share a column (cf. E-223 scrap_vendors.agreement_ref).';
COMMENT ON COLUMN dealer_onboarding_applications.agreement_signed_on IS
  'E-225 — date on the manually signed agreement, as written on the paper. Distinct from signed_at, which is when the SYSTEM recorded completion.';

-- Backfill: every application that already reached Digio is, by definition, an
-- e-sign one. Guarded by `agreement_mode IS NULL` so a re-run — or a later
-- hand-correction — is never clobbered.
--
-- Rows with no provider_document_id are deliberately LEFT NULL rather than
-- guessed at: an application that has not started its agreement has no mode
-- yet, and dealer-capabilities.ts derives the intended one from dealer_type at
-- read time. Writing a mode here would freeze a guess made before the dealer
-- type was even consulted.
UPDATE dealer_onboarding_applications
   SET agreement_mode = 'esign'
 WHERE agreement_mode IS NULL
   AND provider_document_id IS NOT NULL;
