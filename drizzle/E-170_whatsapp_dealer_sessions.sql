-- E-170 — WhatsApp dealer self-service sessions (dealer dashboard over WhatsApp).
--
-- Additive + idempotent. After a dealer is APPROVED, the same WhatsApp number is
-- used for day-to-day work (create leads, customer KYC, inventory, financing) —
-- a DIFFERENT conversation from onboarding (E-167). Onboarding sessions live in
-- whatsapp_onboarding_sessions and are UNTOUCHED here; dealer-mode gets its own
-- session table so the two state machines never collide on wa_phone.
--
-- current_state / session_status are intentionally NOT CHECK-constrained — the
-- state set is code-owned (src/lib/whatsapp/dealer-orchestrator.ts) so adding a
-- state never needs a migration. Mirror every change in src/lib/db/schema.ts.

-- ── 1. Dealer-mode sessions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_dealer_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_phone        varchar(20) NOT NULL,        -- dealer E.164 (no '+')
  dealer_code     varchar(50) NOT NULL,        -- dealers.dealer_id (= leads.dealer_id)
  dealer_user_id  uuid,                         -- users.id (= leads.uploader_id)
  current_state   varchar(32) NOT NULL DEFAULT 'MENU',
  active_lead_id  varchar(255),                 -- the lead draft currently being edited
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_status  varchar(24) NOT NULL DEFAULT 'active', -- active | paused | archived
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_dealer_sessions_wa_phone_idx
  ON whatsapp_dealer_sessions (wa_phone);
CREATE INDEX IF NOT EXISTS whatsapp_dealer_sessions_dealer_code_idx
  ON whatsapp_dealer_sessions (dealer_code);

-- ── 2. Log dealer-mode messages alongside onboarding messages ────────────────
-- whatsapp_messages.session_id FKs to the onboarding sessions table, so we add a
-- separate nullable column for dealer-mode sessions rather than overload it.
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS dealer_session_id uuid;

CREATE INDEX IF NOT EXISTS whatsapp_messages_dealer_session_id_idx
  ON whatsapp_messages (dealer_session_id);

COMMENT ON TABLE whatsapp_dealer_sessions IS
  'E-170 — one row per APPROVED dealer WhatsApp self-service conversation (lead creation, KYC, inventory, financing). Separate from whatsapp_onboarding_sessions (E-167).';
