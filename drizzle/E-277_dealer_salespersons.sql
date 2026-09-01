------------------------------------------------------------------------------
-- E-277: dealer sales team on WhatsApp — many salesperson numbers per dealer.
--
-- PROBLEM. The WhatsApp lead console supports exactly ONE number per dealer
-- (the dealer's own). Dealers have salespersons who onboard customers from
-- their personal WhatsApp numbers; today those numbers fall into the dealer
-- ONBOARDING state machine and mint junk draft applications. This is the
-- mirror image of E-214 (one iTarang operator number → many dealers):
-- many salesperson numbers → one dealer.
--
-- SHAPE. dealer_salespersons is the allowlist: an ACTIVE row maps an inbound
-- wa_phone to exactly one dealer_code. resolveSalesperson() (hot path, every
-- inbound message) gates it in runTurn BEFORE getOrCreateSession, so a
-- salesperson's first "hi" mints a session_kind='salesperson' row instead of a
-- draft application. The salesperson then runs the UNMODIFIED dealer console
-- (runConsoleTurn) with the dealer's ActiveDealer identity plus an actor tag.
--
-- ATTRIBUTION. leads.uploader_id is NOT NULL and must stay the dealer's
-- users.id (salespersons have no login), so — E-214 precedent: "a dedicated
-- column is the only way attribution survives" — leads.salesperson_id records
-- who actually created the lead. Scoping: the dealer's lists filter by
-- dealer_id only (sees everything); a salesperson's lists add
-- salesperson_id = their id (own leads only).
--
-- REMOVAL. Deactivation flips is_active; leads keep dealer_id +
-- salesperson_id. The runTurn gate downgrades the stale salesperson session on
-- their next message.
--
-- Strictly additive and idempotent. With an empty dealer_salespersons table
-- the runtime is unchanged. NOTE: schema.ts mirrors leads.salesperson_id and
-- the session column, and createCustomerLead does a bare insert(leads) —
-- this migration is REQUIRED on an environment before the E-277 code deploys.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dealer_salespersons (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- = dealers.dealer_id / leads.dealer_id. Loose varchar ref, matching how
  -- leads.dealer_id and users.dealer_id reference dealers today.
  dealer_code    varchar(255) NOT NULL,
  -- E.164 WITHOUT '+', exactly as Meta delivers it ('919876543210').
  -- Normalised on write via toWaPhone().
  wa_phone       varchar(20)  NOT NULL,
  display_name   text         NOT NULL,
  is_active      boolean      NOT NULL DEFAULT true,
  -- The dealer's users.id (or admin's) who added the row. Attribution only.
  added_by       uuid,
  -- 'whatsapp' — dealer added them from the My Team chat menu
  -- 'portal'   — dealer-portal Team page
  -- 'admin'    — admin CRM
  added_via      varchar(16)  NOT NULL DEFAULT 'whatsapp',
  deactivated_at timestamptz,
  deactivated_by uuid,
  notes          text,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);

-- One ACTIVE row per phone GLOBALLY: an inbound number resolves to at most one
-- dealer. Deactivation frees the number; re-adding inserts a fresh row so
-- leads.salesperson_id history survives (same reasoning as whatsapp_operators).
CREATE UNIQUE INDEX IF NOT EXISTS dealer_salespersons_active_phone_key
  ON dealer_salespersons (wa_phone) WHERE is_active;

CREATE INDEX IF NOT EXISTS dealer_salespersons_dealer_idx
  ON dealer_salespersons (dealer_code, created_at DESC);

-- ── Leads: creator attribution ──────────────────────────────────────────────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS salesperson_id uuid;

CREATE INDEX IF NOT EXISTS leads_salesperson_idx
  ON leads (salesperson_id) WHERE salesperson_id IS NOT NULL;

COMMENT ON COLUMN leads.salesperson_id IS
  'E-277: dealer_salespersons.id of the salesperson who created this lead over WhatsApp. NULL = the dealer themselves (or a non-WhatsApp channel). uploader_id stays the dealer''s users.id — salespersons have no login.';

-- ── Sessions: salesperson kind ──────────────────────────────────────────────
-- session_kind gains the code-owned value 'salesperson' (varchar, no DB
-- constraint — no DDL needed for the value itself).
ALTER TABLE whatsapp_onboarding_sessions
  ADD COLUMN IF NOT EXISTS salesperson_id uuid;

-- One live salesperson session per phone, mirroring the operator_hub partial
-- unique: getOrCreateSession is a deliberately unlocked read-then-insert, and a
-- forked salesperson session would fork mid-lead console state.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_sessions_salesperson_key
  ON whatsapp_onboarding_sessions (wa_phone) WHERE session_kind = 'salesperson';

COMMENT ON COLUMN whatsapp_onboarding_sessions.salesperson_id IS
  'E-277: dealer_salespersons.id when session_kind=''salesperson''. Mirrors operator_id for E-214 hubs.';
