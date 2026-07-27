------------------------------------------------------------------------------
-- E-214: internal WhatsApp onboarding operators — many dealers per number.
--
-- PROBLEM. The WhatsApp dealer-onboarding bot supports exactly ONE dealer per
-- WhatsApp number. That was never a DB constraint: getOrCreateSession() does
-- `WHERE wa_phone = $1 ORDER BY created_at DESC LIMIT 1` and treats the row it
-- gets back as the caller's identity, and the row is immortal per phone (stop /
-- restart reuse the same session AND the same application). iTarang's internal
-- onboarding team needs each member to onboard MANY dealers from their own
-- single number.
--
-- SHAPE. wa_phone has only a plain index on whatsapp_onboarding_sessions, so
-- several rows per number are already legal. session_kind splits them:
--   'dealer'        — every pre-existing row, and every self-onboarding dealer
--   'operator_hub'  — one per operator number; holds the OP_* menu state
--   'operator_file' — one per dealer file an operator has open. Same wa_phone as
--                     the hub, so replies still reach the operator, while the
--                     UNMODIFIED onboarding state machine runs against a
--                     per-dealer row (its own current_state / context /
--                     application_id). No handler changes; the Gemini/Decentro
--                     document pipeline is reused verbatim.
--
-- WHY A SEPARATE ALLOWLIST TABLE AND NOT users.role: the gate is keyed on an
-- inbound WhatsApp phone, not a login. users.phone is free-text and unvalidated,
-- and resolveKnownContact() already matches it for a purely COSMETIC greeting —
-- making that lookup load-bearing would silently promote every staff member with
-- a mobile on file into an onboarding operator. users.id here is an OPTIONAL
-- attribution link, not the key.
--
-- WHY onboarding_operator_id ON THE APPLICATION: the approve route sets
-- dealer_onboarding_applications.dealer_user_id = the DEALER's Supabase auth id.
-- That column currently doubles as "who created this draft"
-- (api/dealer-onboarding/my), so creator attribution is destroyed at approval. A
-- dedicated column is the only way operator attribution survives.
--
-- Strictly additive and idempotent. Every default reproduces today's behaviour
-- exactly: session_kind='dealer' + onboarding_channel='self' on all existing
-- rows, so with an empty whatsapp_operators table the runtime is unchanged.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_operators (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- E.164 WITHOUT '+', exactly as Meta delivers it in the webhook
  -- ('919876543210'). Normalised on write by the admin API.
  wa_phone       varchar(20) NOT NULL,
  display_name   text        NOT NULL,
  -- Optional link to the internal CRM login. NOT the identity key: an operator
  -- is identified by wa_phone alone, so a team member with no login still works.
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  email          varchar(150),
  is_active      boolean     NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  deactivated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per number, ever. Deactivation flips is_active rather than deleting,
-- so history (onboarding_operator_id references) and re-activation both survive.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_operators_wa_phone_key
  ON whatsapp_operators (wa_phone);

-- The hot path: resolveOperator() runs on every inbound message.
CREATE INDEX IF NOT EXISTS whatsapp_operators_active_idx
  ON whatsapp_operators (wa_phone) WHERE is_active;


-- ── Sessions: hub / file discrimination ────────────────────────────────────
ALTER TABLE whatsapp_onboarding_sessions
  ADD COLUMN IF NOT EXISTS session_kind      varchar(16) NOT NULL DEFAULT 'dealer',
  ADD COLUMN IF NOT EXISTS operator_id       uuid REFERENCES whatsapp_operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_session_id uuid;

-- getOrCreateSession() looks up "newest row for this phone that is NOT an
-- operator_file"; this index serves that and the admin pipeline listing.
CREATE INDEX IF NOT EXISTS whatsapp_onboarding_sessions_phone_kind_idx
  ON whatsapp_onboarding_sessions (wa_phone, session_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_onboarding_sessions_operator_idx
  ON whatsapp_onboarding_sessions (operator_id, created_at DESC);

-- The only unique constraint this table has ever had. getOrCreateSession is a
-- deliberately unlocked read-then-insert (orchestrator.ts header) — for a plain
-- dealer a double-insert is a cosmetic duplicate, but for an operator it would
-- fork the menu state. Partial, so existing dealer rows are untouched and this
-- cannot fail on existing data.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_onboarding_sessions_operator_hub_key
  ON whatsapp_onboarding_sessions (wa_phone) WHERE session_kind = 'operator_hub';


-- ── Applications: operator attribution + the two WhatsApp channels ─────────
ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS onboarding_operator_id uuid REFERENCES whatsapp_operators(id) ON DELETE SET NULL,
  -- 'self'             — dealer chatted us directly (today's only case)
  -- 'operator'         — operator is uploading the documents themselves
  -- 'operator_handoff' — operator handed the doc / e-sign steps to the dealer
  ADD COLUMN IF NOT EXISTS onboarding_channel     varchar(24) NOT NULL DEFAULT 'self',
  -- The OPERATOR's per-dealer file session. Distinct from wa_session_id, which
  -- keeps its existing meaning: the DEALER's own session. Both can be non-null
  -- after a handoff.
  ADD COLUMN IF NOT EXISTS wa_operator_session_id uuid,
  ADD COLUMN IF NOT EXISTS operator_invited_at    timestamptz,
  ADD COLUMN IF NOT EXISTS operator_handoff_at    timestamptz;

CREATE INDEX IF NOT EXISTS dealer_onboarding_applications_operator_idx
  ON dealer_onboarding_applications (onboarding_operator_id, created_at DESC);

COMMENT ON COLUMN dealer_onboarding_applications.onboarding_operator_id IS
  'E-214: internal operator who created this file. Deliberately NOT dealer_user_id — the approve route overwrites that with the dealer''s Supabase auth id.';
COMMENT ON COLUMN dealer_onboarding_applications.wa_phone IS
  'E-214 clarification: ALWAYS the DEALER''s own WhatsApp number, never the operator''s. It is the destination for approval credentials and the key resolveWhatsAppDealer() matches on.';
COMMENT ON COLUMN whatsapp_onboarding_sessions.session_kind IS
  'E-214: dealer | operator_hub | operator_file. Pre-existing rows default to dealer, preserving the single-dealer-per-number flow byte-for-byte.';
