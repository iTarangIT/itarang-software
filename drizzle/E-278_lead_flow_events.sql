------------------------------------------------------------------------------
-- E-278: per-lead action/step audit trail for the WhatsApp console
--        ("Team Leads" takeover + "History" timeline).
--
-- PROBLEM. E-277 lets a dealer's salespersons work customer leads from their
-- own WhatsApp numbers, but nothing records WHO took a lead to WHICH step:
--   - audit_logs.performed_by is a users.id and salespersons have no login row;
--   - whatsapp_messages has no lead_id;
--   - a salesperson's mid-journey position (ctx.parked) lives in THEIR
--     session's context jsonb, unreadable from the dealer's session.
-- So the main dealer can neither see where a team lead stands nor take it
-- over, and there is no per-lead history at all.
--
-- SHAPE. One append-only event stream. Events are written from a single choke
-- point wrapped around runConsoleTurn (state transitions) plus three explicit
-- write points (lead created, submitted to iTarang, journey button taps).
-- The newest journey `to_state` doubles as the lead's last-known position, so
-- the dealer's Team Leads takeover never needs to read a foreign session.
--
-- Strictly additive and idempotent. Every read/write in the code swallows
-- errors (src/lib/whatsapp/lead-events.ts), so the code ships safely ahead of
-- this DDL — an unapplied environment simply records no history.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lead_flow_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- = leads.id (generated string like LEAD-20260824-0042). Loose varchar ref,
  -- matching how leads.dealer_id references dealers today.
  lead_id        varchar(255) NOT NULL,
  -- = leads.dealer_id, denormalised so the dealer-scope listing needs no join.
  dealer_code    varchar(255) NOT NULL,
  -- 'dealer' | 'salesperson' | 'customer' | 'system'. Code-owned, no constraint.
  actor_kind     varchar(16)  NOT NULL,
  -- dealer_salespersons.id when actor_kind='salesperson'.
  salesperson_id uuid,
  -- Display-name snapshot at write time — History renders join-free, and the
  -- name survives the salesperson later being removed from the team.
  actor_label    text,
  -- whatsapp_onboarding_sessions.current_state values (varchar(32) there too).
  from_state     varchar(32),
  to_state       varchar(32),
  -- 'created' | 'submitted' | 'state' | 'takeover' | 'action:<LeadActionKey>'.
  action         varchar(32)  NOT NULL DEFAULT 'state',
  note           text,
  created_at     timestamptz  NOT NULL DEFAULT now()
);

-- History timeline + latest-position lookups.
CREATE INDEX IF NOT EXISTS lead_flow_events_lead_idx
  ON lead_flow_events (lead_id, created_at);

-- Dealer-scope listings ("most recently active leads").
CREATE INDEX IF NOT EXISTS lead_flow_events_dealer_idx
  ON lead_flow_events (dealer_code, created_at DESC);
