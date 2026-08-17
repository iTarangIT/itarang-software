-- E-243: the dealer's own answer to a quotation.
--
-- WHY
--   E-242 ends at "sent". Whether the dealer then said yes lived wherever the
--   reply happened to land — a WhatsApp thread, somebody's inbox, a phone call
--   nobody logged — so the CRM could say a quotation went out and never say
--   what came back. This is the half Kartik parked:
--
--     "If the dealer approves it on WhatsApp or email, then if we can bring
--      that into our system, that would be great."  (08:51)
--
-- WHY COLUMNS ON THE QUOTE, NOT A NEW TABLE
--   A quotation has exactly one dealer answer. dealer_lead_commercials is
--   already versioned — one row IS one quotation — so the answer belongs on the
--   row it answers. A separate table would need a uniqueness rule to say the
--   same thing and would let a quote and its verdict drift apart. Same
--   reasoning E-221 gave for putting approval_status here rather than in an
--   approvals table.
--
--   The CHANNEL EVIDENCE is what makes this auditable rather than a bare flag:
--   dealer_decision_via says how the answer arrived and dealer_decision_actor
--   records the identifier behind it (the WhatsApp number, or the token that
--   was clicked). "The dealer approved this" is a claim about someone outside
--   the company, so the row has to be able to say why we believe it.
--
-- WHY THERE IS NO TOKEN TABLE
--   The approval link carries an HMAC of (commercial_id, version_no) under a
--   server secret — src/lib/leads/quoteToken.ts. It is verifiable without
--   storage, so there is nothing to insert when a quotation is sent and nothing
--   to clean up when it is not answered. Single-use is enforced by the DECISION
--   instead: the write is conditional on dealer_decision IS NULL, so a replayed
--   link finds the answer already recorded and changes nothing. That makes a
--   forwarded email harmless rather than a second vote.
--
-- WHY THE LEAD STATUS IS NOT TOUCHED
--   Deliberate. A dealer tapping a button is an outside party, and letting one
--   drive the internal state machine would mean a mis-tap silently rewrites
--   pipeline reporting. The decision is recorded and the owner is notified; a
--   human still moves the lead. The conversion flow of E-242 §7 is unchanged.
--
-- Free text, no CHECK and no enum, per this table family's convention
-- (E-202, E-218, E-220, E-221, E-226, E-230, E-242). The vocabulary lives in
-- src/lib/leads/quoteDecision.ts and is enforced by zod at the write path.
--
-- MIRRORED IN schema.ts. dealer_lead_commercials has no bare
-- `db.select().from(...)` anywhere — every read names its columns — so the only
-- statement drizzle expands is the INSERT in the inside-sales commercials
-- route, which already depends on E-242. Contrast dealer_leads, whose new
-- columns are deliberately absent from schema.ts for exactly that reason.
--
-- DEPENDS ON E-242_quotation_draft_dispatch — apply that first.
--
-- Additive and idempotent — safe to re-run.

BEGIN;

ALTER TABLE dealer_lead_commercials
  ADD COLUMN IF NOT EXISTS dealer_decision       varchar(16),
  ADD COLUMN IF NOT EXISTS dealer_decision_at    timestamptz,
  ADD COLUMN IF NOT EXISTS dealer_decision_via   varchar(20),
  ADD COLUMN IF NOT EXISTS dealer_decision_actor text,
  ADD COLUMN IF NOT EXISTS dealer_decision_note  text;

COMMENT ON COLUMN dealer_lead_commercials.dealer_decision IS
  'E-243: approved | declined, as stated by the DEALER. Orthogonal to '
  'approval_status, which is iTarang''s internal gate — a quotation we approved '
  'and released can still be declined by the dealer, and both facts have to be '
  'readable at once. NULL means no answer yet, which is every quotation until '
  'one arrives.';

COMMENT ON COLUMN dealer_lead_commercials.dealer_decision_via IS
  'E-243: link | whatsapp. How the answer reached us — the signed approval page '
  'or a tapped WhatsApp button. Free text, no CHECK; vocabulary in '
  'src/lib/leads/quoteDecision.ts.';

COMMENT ON COLUMN dealer_lead_commercials.dealer_decision_actor IS
  'E-243: the identifier behind the answer — the dealer''s WhatsApp number, or '
  '"token" for a signed-link click. This is the evidence for a claim about '
  'somebody outside the company, so it is recorded rather than implied.';

COMMENT ON COLUMN dealer_lead_commercials.dealer_decision_note IS
  'E-243: anything the dealer typed alongside the decision — a decline reason, '
  'a counter-offer in prose. Optional and usually NULL; a button carries none.';

-- The two panels that read this ask "which quotations are still unanswered" and
-- "what came back recently", both over decided rows only. Partial, because the
-- answered slice stays small next to the whole commercials history.
CREATE INDEX IF NOT EXISTS dealer_lead_commercials_dealer_decision_idx
  ON dealer_lead_commercials (dealer_decision_at DESC)
  WHERE dealer_decision IS NOT NULL;

-- No backfill. Every existing quotation was sent before an answer could be
-- captured, so NULL — "we never asked in a way we could record" — is the true
-- statement about all of them. Inferring approval from a lead that later
-- converted would invent evidence.

COMMIT;
