-- =============================================================================
-- E-379 — AI DIALER: NUMBERS AND NAMES A CALL LEARNED (AI dialer list item 6)
-- =============================================================================
-- WHY.
--   Staff answer the shop number and say "malik ka number likh lo …"; an IVR
--   or landline main number can never reach the owner. The analyser now reads
--   the owner's name, the owner's own mobile and any other number the dealer
--   asked us to call (signals-2.5.0). They were lost in the transcript.
--
-- WHAT. dealer_lead_contacts — one row per (lead, number):
--   kind            owner_mobile | alternate
--   phone           ten digits (src/lib/ai-dialer/contactCapture.ts validates)
--   name            the owner's name when said
--   source_call_id  the call that learned it
--   status          active | wrong (a rep, or an IVR / dead-number result on
--                   a dial to it, retired it)
--   last_call_id    the last dial placed TO this number — its result is
--                   applied to this row, not to the lead's main number
--   captured_at / updated_at
--
-- Used by the dialer: a lead whose main number is a switchboard / dead / not a
-- mobile is dialled on its active owner mobile (else alternate) instead of
-- being skipped; inbound calls from these numbers match the lead.
--
-- A new raw-SQL table behind to_regclass (src/lib/ai-dialer/contactStore.ts),
-- NOT mirrored in schema.ts: without it nothing is stored and the dialer skips
-- such leads as before. Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS dealer_lead_contacts (
    id              text         PRIMARY KEY DEFAULT ('dlc_' || replace(gen_random_uuid()::text, '-', '')),
    lead_id         text         NOT NULL,
    kind            varchar(20)  NOT NULL,
    phone           varchar(10)  NOT NULL,
    name            text,
    source_call_id  text,
    status          varchar(10)  NOT NULL DEFAULT 'active',
    last_call_id    text,
    captured_at     timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dealer_lead_contacts_lead_phone_uniq
    ON dealer_lead_contacts (lead_id, phone);
CREATE INDEX IF NOT EXISTS dealer_lead_contacts_last_call_idx
    ON dealer_lead_contacts (last_call_id) WHERE last_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dealer_lead_contacts_phone_idx
    ON dealer_lead_contacts (phone) WHERE status = 'active';

COMMENT ON TABLE dealer_lead_contacts IS
    'E-379: owner mobile / alternate numbers an AI call learned (AI dialer list item 6); src/lib/ai-dialer/contactStore.ts.';
