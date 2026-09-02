------------------------------------------------------------------------------
-- E-279: extra MAIN-dealer WhatsApp numbers — many numbers per dealership.
--
-- PROBLEM. A dealership has exactly ONE WhatsApp number that resolves to the
-- main-dealer console (dealer_onboarding_applications.wa_phone or
-- dealers.owner_phone, both single-column). Dealers want several numbers —
-- e.g. two partners of Ayansh Engineering — to ALL act as the main dealer:
-- full console, create customer leads for the dealership, see every lead,
-- Team Leads takeover. This is the full-scope sibling of E-277
-- (dealer_salespersons = many restricted numbers → one dealer): here the
-- numbers are UNRESTRICTED main-dealer identities.
--
-- SHAPE. dealer_extra_numbers is an admin-managed allowlist: an ACTIVE row
-- maps an inbound wa_phone to exactly one dealer_code. Resolution rides the
-- existing runTurn gate 12 fallback — resolveWhatsAppDealer() gains a third
-- lookup step against this table and returns the SAME full-scope identity a
-- dealers.owner_phone match does (ActiveDealer without an actor tag). No new
-- session kind: extra numbers ride plain 'dealer'-kind sessions exactly like
-- web-onboarded dealers.
--
-- ATTRIBUTION. Leads created from an extra number are ordinary main-dealer
-- leads: leads.dealer_id = dealer_code, uploader_id = the dealer's users.id,
-- salesperson_id NULL. No lead column is needed.
--
-- REMOVAL. Deactivation flips is_active (never delete); the service layer
-- resets the number's live session so it falls back to onboarding cleanly.
--
-- Strictly additive and idempotent. Runtime reads are try/catch-guarded, so
-- an environment without this migration simply behaves pre-E-279.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dealer_extra_numbers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- = dealers.dealer_id / leads.dealer_id. Loose varchar ref, matching how
  -- leads.dealer_id and users.dealer_id reference dealers today.
  dealer_code    varchar(255) NOT NULL,
  -- E.164 WITHOUT '+', exactly as Meta delivers it ('919876543210').
  -- Normalised on write via toWaPhone().
  wa_phone       varchar(20)  NOT NULL,
  -- Label for the admin table, e.g. "Partner — Rakesh" / "Branch — Kochi".
  display_name   text         NOT NULL,
  is_active      boolean      NOT NULL DEFAULT true,
  -- The admin users.id who added the row. Attribution only.
  added_by       uuid,
  added_via      varchar(16)  NOT NULL DEFAULT 'admin',
  deactivated_at timestamptz,
  deactivated_by uuid,
  notes          text,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);

-- One ACTIVE row per phone GLOBALLY: an inbound number resolves to at most one
-- dealership. Deactivation frees the number; re-adding inserts a fresh row
-- (same reasoning as dealer_salespersons / whatsapp_operators).
CREATE UNIQUE INDEX IF NOT EXISTS dealer_extra_numbers_active_phone_key
  ON dealer_extra_numbers (wa_phone) WHERE is_active;

CREATE INDEX IF NOT EXISTS dealer_extra_numbers_dealer_idx
  ON dealer_extra_numbers (dealer_code, created_at DESC);
