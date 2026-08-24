-- E-264: WhatsApp full-journey onboarding — shared foundation.
--
-- WHY THIS IS ONE MIGRATION AND NOT FOUR. Everything here is the substrate the
-- four delivery phases (co-borrower, Step-4 routing, offers/sanction, dispatch)
-- stand on: how we find the chat that belongs to a lead, how we reach a customer
-- whose 24-hour window has shut, how we hand them a page without a login, and
-- how a self-serve lead waits for a dealer. Splitting it per-phase would mean
-- phase 2 could not ship without phase 1's DDL anyway.
--
-- Strictly additive: one new table, six new nullable/defaulted columns across
-- two existing tables, five indexes. Nothing dropped, narrowed, or backfilled
-- destructively. Re-running this file is a no-op.

-- ---------------------------------------------------------------------------
-- 1. Find the conversation that belongs to a lead, without a sequential scan.
-- ---------------------------------------------------------------------------
-- pushSignedConsentToWhatsApp has always located its session by matching
-- `context -> 'lead' ->> 'leadId'`, which reads every session row. That was
-- tolerable at one call site fired by a Digio webhook. It stops being tolerable
-- once five out-of-band journey events per lead go through the same predicate.
CREATE INDEX IF NOT EXISTS whatsapp_sessions_lead_id_idx
  ON whatsapp_onboarding_sessions ((context -> 'lead' ->> 'leadId'))
  WHERE context -> 'lead' ->> 'leadId' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The 24-hour window: park the prompt we were not allowed to send.
-- ---------------------------------------------------------------------------
-- A Meta template cannot carry a 10-row list, cannot carry more than 3 buttons,
-- and rejects newlines in body parameters. So a template can never BE a step of
-- the journey -- only a doorbell. The real interactive prompt is stored here and
-- replayed on the customer's next inbound message, which is the moment the
-- service window re-opens. (Sending the template does NOT re-open it; only the
-- customer's reply does. That asymmetry is the whole reason this column exists.)
ALTER TABLE whatsapp_onboarding_sessions
  ADD COLUMN IF NOT EXISTS pending_prompt jsonb;
ALTER TABLE whatsapp_onboarding_sessions
  ADD COLUMN IF NOT EXISTS pending_prompt_at timestamptz;
-- Meta scores a business down for unanswered template sends, and a poor quality
-- rating throttles the number. Cap the doorbell.
ALTER TABLE whatsapp_onboarding_sessions
  ADD COLUMN IF NOT EXISTS window_nudges_sent integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. One-tap tokenised links to a page that needs no login.
-- ---------------------------------------------------------------------------
-- Neither existing token system fits. nbfc_doc_requests.act_token_hash hashes
-- correctly but its consumer page still wants an admin browser session, and the
-- token is owned by a request row. other_document_requests.upload_token has the
-- right no-session semantics but stores the secret in PLAINTEXT and is minted by
-- three duplicated generators. This takes the hashing from the first and the
-- audience from the second, and owns the token itself so any purpose can reuse
-- it. The existing upload_token surface is deliberately left alone -- migrating
-- it is a separate, riskier change against three generators and a live route.
CREATE TABLE IF NOT EXISTS lead_action_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      varchar(255) NOT NULL,
  -- co_borrower | step4 | offers | step5. No CHECK: the vocabulary lives in
  -- src/lib/leads/action-token.ts so it can grow without a migration against a
  -- drifting database -- the same convention as the E-232/E-263 status columns.
  purpose      varchar(32) NOT NULL,
  -- sha256(raw) only. The raw token rides in the WhatsApp message and nowhere
  -- else, so a database read alone cannot forge an action. Mirrors hashActToken.
  token_hash   varchar(64) NOT NULL,
  audience     varchar(16) NOT NULL DEFAULT 'customer',
  -- The number it was issued to, so a link used from somewhere else is at least
  -- visible in the audit trail. Not enforced: a customer forwarding the link to
  -- their spouse is the normal case, not an attack.
  wa_phone     varchar(20),
  -- Optional back-pointer: co_borrower_requests.id, nbfc_doc_requests.id, ...
  ref_id       varchar(255),
  expires_at   timestamptz NOT NULL,
  -- Set when the page completes its action. Nullable because several purposes
  -- (step4, offers) are legitimately re-openable inside their window.
  consumed_at  timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_action_tokens_hash_unique
  ON lead_action_tokens (token_hash);
CREATE INDEX IF NOT EXISTS lead_action_tokens_lead_purpose_idx
  ON lead_action_tokens (lead_id, purpose, expires_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Self-serve leads that do not have a dealer yet.
-- ---------------------------------------------------------------------------
-- dealer_id deliberately stays populated with the house dealer. It IS nullable
-- in DDL, but roughly every read path compares lead.dealer_id against the
-- caller's dealer code -- so a NULL there does not mean "unassigned", it means
-- "invisible to everyone, including the queue meant to rescue it". Ownership is
-- therefore expressed by a flag, and the house dealer becomes an honest holding
-- pen rather than a pretend owner.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS assignment_status varchar(24) NOT NULL DEFAULT 'assigned';
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS dealer_assigned_at timestamptz;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS dealer_assigned_by uuid;

CREATE INDEX IF NOT EXISTS leads_unassigned_queue_idx
  ON leads (created_at DESC)
  WHERE assignment_status = 'unassigned';

-- ---------------------------------------------------------------------------
-- 5. Co-borrower integrity.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS co_borrower_documents_lead_type_idx
  ON co_borrower_documents (lead_id, document_type);

-- One co-borrower per lead. requestCoBorrowerForLead() and the coborrower POST
-- route both do find-or-insert with no constraint behind them, so two concurrent
-- writers can create two rows -- and every later reader takes limit(1), silently
-- picking one. Guarded, because a database that ALREADY has duplicates must
-- still be able to take this migration.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM co_borrowers GROUP BY lead_id HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS co_borrowers_lead_unique
      ON co_borrowers (lead_id);
  ELSE
    CREATE INDEX IF NOT EXISTS co_borrowers_lead_idx_nonunique
      ON co_borrowers (lead_id);
    RAISE NOTICE 'E-264: co_borrowers has duplicate lead_id rows; created a NON-UNIQUE index instead. De-duplicate, then create co_borrowers_lead_unique by hand.';
  END IF;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-264: co_borrowers not present; skipping.';
END;
$do$;

-- ---------------------------------------------------------------------------
-- Self-documentation
-- ---------------------------------------------------------------------------
COMMENT ON TABLE lead_action_tokens IS
  'E-264: hashed, purpose-scoped, no-login magic links handed to a customer over WhatsApp. The raw token exists only in the chat message; only its sha256 is stored.';
COMMENT ON COLUMN whatsapp_onboarding_sessions.pending_prompt IS
  'E-264: the interactive prompt we could not send because the 24h service window was shut. Replayed verbatim on the next inbound message.';
COMMENT ON COLUMN whatsapp_onboarding_sessions.window_nudges_sent IS
  'E-264: template nudges sent since the last inbound. Reset on inbound; capped to protect the WABA quality rating.';
COMMENT ON COLUMN leads.assignment_status IS
  'E-264: unassigned | assigned. A WhatsApp self-serve lead lands unassigned; an admin routes it to a real dealer before Step 4. dealer_id still points at the house dealer meanwhile -- see the migration header for why it is not NULL.';
