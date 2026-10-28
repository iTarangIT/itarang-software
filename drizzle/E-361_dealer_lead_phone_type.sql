-- =============================================================================
-- E-361 — AI DIALER: MOBILES ONLY, AND A "NEEDS DEALER MOBILE" LIST
--          (Priya call drops B1, 27 Oct 2026)
-- =============================================================================
-- WHY.
--   15 of 54 "connected" AI calls on 21-22 Oct went to 080-6xxx / 080-7xxx
--   cloud-telephony numbers from Google listings. They answer at once and
--   forward nowhere, so the dealer is never reached and the lead is marked
--   contacted. City landlines (Patna 0612, Bhopal 0755, Raipur 0771) behave the
--   same. Stored as +91…, their last ten digits look like a mobile, so a regex
--   cannot tell them apart; libphonenumber can (src/lib/ai-dialer/numberHygiene.ts).
--
-- WHAT.
--   dealer_lead_phone_type — the phone type of each lead's number, as computed
--   for `phone`. A lead whose type is not mobile / fixed_or_mobile is not
--   enrolled in AI campaigns and shows under "Needs dealer mobile" on /leads, so
--   the scraper or an ISR can find the dealer's mobile. A row whose `phone` no
--   longer equals dealer_leads.phone is stale and ignored.
--   Written when a campaign is created and by scripts/_backfill-e361-phone-types.ts.
--
-- A NEW TABLE, not a column on dealer_leads: Drizzle names every mirrored column
-- in its SQL, so a column would make this migration REQUIRED for every lead
-- reader. NOT mirrored in schema.ts — raw SQL behind a to_regclass probe.
-- Without the table the dialer still skips landlines; only the filter is off.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS dealer_lead_phone_type (
    lead_id     text         PRIMARY KEY REFERENCES dealer_leads(id) ON DELETE CASCADE,
    phone       text         NOT NULL,
    phone_type  varchar(20)  NOT NULL,
    checked_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dealer_lead_phone_type_not_mobile_idx
    ON dealer_lead_phone_type (lead_id)
    WHERE phone_type NOT IN ('mobile', 'fixed_or_mobile');

COMMENT ON TABLE dealer_lead_phone_type IS
  'E-361 — phone type of each dealer lead''s number (libphonenumber: mobile, fixed_or_mobile, fixed_line, toll_free, other, invalid). Not mobile = not dialled by the AI dialer and listed under Needs dealer mobile on /leads. Stale when phone <> dealer_leads.phone.';
COMMENT ON COLUMN dealer_lead_phone_type.phone IS
  'The number phone_type was computed for. Compared with dealer_leads.phone; a mismatch means the lead''s number changed and this row no longer applies.';
