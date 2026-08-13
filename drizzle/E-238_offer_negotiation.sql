-- E-238: dealer ⇄ NBFC negotiation on a firm financing offer, with an NBFC
--        "Fix" action that ends it.
--
-- WHY
--   The firm offer is currently take-it-or-leave-it. The NBFC submits terms
--   (POST /api/nbfc/offer/[leadId]) and the dealer's ONLY action is
--   "Select as winner" (POST /api/lead/[id]/select-winner). A customer who
--   wants 16% over 48 months instead of 18.5% over 36 has no route through the
--   system, so that conversation happens on the phone and is never recorded —
--   even though select-winner is the formal sanction moment (Addendum §14.2)
--   and this portal's whole premise is an immutable audit log.
--
--   This file adds the round-by-round record that conversation needs, plus the
--   lock that ends it.
--
-- WHY A SEPARATE TABLE AND NOT MORE COLUMNS ON nbfc_financing_offers
--   nbfc_financing_offers is UNIQUE on assignment_id and the submit route
--   upserts in place (onConflictDoUpdate). Every resubmit therefore DESTROYS
--   the previous terms. There is nowhere on that row for round 1 to live once
--   round 3 exists, and "what did they originally offer?" is precisely the
--   question a disputed sanction turns on. History needs its own table; the
--   offers row stays the single current-terms record it already is.
--
-- WHY ROUNDS AND NOT ask/counter/agreed COLUMNS
--   vendor_thread_lines (E-186, scrap buyback) models a price negotiation as
--   ask_price / counter_price / agreed_price on one line, which works when a
--   line is one number haggled once. A financing offer is SIX interdependent
--   numbers — drop the ROI and the EMI moves — negotiated as a set, and more
--   than once. So the unit here is a round: a full snapshot of what one party
--   put on the table at one moment. The UI diffs consecutive rounds to show
--   only what changed; storing the whole set is what makes that diff possible
--   at all, and what makes a round replayable years later.
--
-- WHY negotiation_status IS STORED AND NOT DERIVED
--   It could be read off the last round's `party`. But the dealer's offers list
--   renders a button per row from it, and deriving would mean a correlated
--   subquery on a path that runs on every poll. Same call E-224 made for
--   neodove_sync_status. The negotiation_round counter is stored for the same
--   reason and doubles as the optimistic-concurrency handle: the round number
--   written is always negotiation_round + 1, and the UNIQUE index below turns a
--   double-submit into a 23505 instead of two rows both claiming "round 3".
--
-- WHY NO FK CONSTRAINTS
--   Consistent with the whole nbfc_* family — nbfc_financing_offers itself
--   declares none. These files are applied BY HAND to databases that drift
--   (see MIGRATION_CHECKLIST.md), and a FK turns a missing parent into a failed
--   INSERT at runtime rather than a dangling id somebody can repair.
--
-- WHY NO CHECK CONSTRAINTS ON party / kind / negotiation_status
--   The vocabulary is enforced in the TS service layer and recorded in the
--   COMMENTs below, per E-202/E-218/E-226/E-231/E-232/E-233. (E-140's
--   nbfc_financing_offers_status_check predates that convention; not extended.)
--
-- THE INVARIANT THIS FILE EXISTS TO SUPPORT
--   A round is written ONLY when its terms are visible to the dealer. E-161
--   holds an out-of-band offer at ceo_approval_status='pending' and
--   GET /api/lead/[id]/offers filters it out; appending a round for terms no
--   one has approved would leak them into the dealer's history. So the writer
--   appends on the same condition that already gates the offer_submitted flip,
--   and applyFinancingOfferDeviationApproval appends on CEO approval.
--
-- REQUIRED — this one is not optional.
--   Both halves ARE mirrored in src/lib/db/schema.ts, and
--   src/app/api/nbfc/offer/[leadId]/route.ts does a bare
--   db.select().from(nbfcFinancingOffers). Drizzle names every column of a
--   mirrored table in its generated SQL, so an unapplied E-238 does NOT degrade
--   quietly — it takes the NBFC offer panel down with
--   `column "negotiation_status" does not exist` on the first read.
--   (Contrast E-236/E-237, whose columns are deliberately unmirrored and
--   reached through raw sql precisely so they can degrade.)
--
-- Additive and idempotent — safe to re-run.
-- Apply with: node scripts/apply-e238.mjs

BEGIN;

CREATE TABLE IF NOT EXISTS nbfc_offer_negotiations (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id        uuid          NOT NULL,
  assignment_id   uuid          NOT NULL,
  lead_id         varchar(50)   NOT NULL,
  nbfc_id         integer       NOT NULL,
  tenant_id       uuid          NOT NULL,
  round           integer       NOT NULL,
  party           varchar(8)    NOT NULL,
  kind            varchar(16)   NOT NULL,
  loan_amount     numeric(14,2),
  roi_pct         numeric(5,2),
  emi_amount      numeric(14,2),
  tenure_months   integer,
  down_payment    numeric(14,2),
  processing_fee  numeric(14,2),
  conditions      text,
  message         text,
  created_by      uuid,
  created_at      timestamptz   NOT NULL DEFAULT now()
);

-- The concurrency guard, not a tidiness index: two simultaneous submits both
-- computing negotiation_round + 1 must not both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS nbfc_offer_negotiations_offer_round_uidx
  ON nbfc_offer_negotiations (offer_id, round);

CREATE INDEX IF NOT EXISTS nbfc_offer_negotiations_offer_idx
  ON nbfc_offer_negotiations (offer_id);
CREATE INDEX IF NOT EXISTS nbfc_offer_negotiations_lead_idx
  ON nbfc_offer_negotiations (lead_id);
CREATE INDEX IF NOT EXISTS nbfc_offer_negotiations_tenant_idx
  ON nbfc_offer_negotiations (tenant_id);

COMMENT ON TABLE nbfc_offer_negotiations IS
  'E-238: append-only round log of the dealer<->NBFC negotiation over one firm '
  'financing offer. One row per round; each row is a FULL snapshot of the terms '
  'that party put on the table, so consecutive rounds can be diffed. Written '
  'only when the terms are visible to the dealer (never while E-161 holds an '
  'out-of-band offer for iTarang CEO approval).';

COMMENT ON COLUMN nbfc_offer_negotiations.offer_id IS
  'E-238: nbfc_financing_offers.id. No FK, per this family''s convention.';
COMMENT ON COLUMN nbfc_offer_negotiations.assignment_id IS
  'E-238: nbfc_lead_assignments.id, denormalised so a round can be tenant-scoped '
  'without joining back through the offer.';
COMMENT ON COLUMN nbfc_offer_negotiations.round IS
  'E-238: 1-based, contiguous, and UNIQUE per offer. Round 1 is always the '
  'NBFC''s opening terms — seeded lazily on the first counter for offers that '
  'predate this migration, which is why no data backfill ships with it.';
COMMENT ON COLUMN nbfc_offer_negotiations.party IS
  'E-238: nbfc | dealer. No CHECK — enforced in the route layer, per '
  'E-202/E-218/E-226/E-231/E-232/E-233.';
COMMENT ON COLUMN nbfc_offer_negotiations.kind IS
  'E-238: offer (NBFC submitted/revised) | counter (dealer asked) | fix (NBFC '
  'froze the terms). No CHECK — enforced in the route layer.';
COMMENT ON COLUMN nbfc_offer_negotiations.conditions IS
  'E-238: NBFC rounds only — mirrors nbfc_financing_offers.conditions at that round.';
COMMENT ON COLUMN nbfc_offer_negotiations.message IS
  'E-238: free-text note from either party. Capped at 2000 chars in the route.';
COMMENT ON COLUMN nbfc_offer_negotiations.created_by IS
  'E-238: users.id of whoever wrote the round — an NBFC officer or the dealer.';

-- ── nbfc_financing_offers — current negotiation state on the offer itself ────
ALTER TABLE nbfc_financing_offers
  ADD COLUMN IF NOT EXISTS negotiation_status varchar(16) NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS negotiation_round  integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fixed_at           timestamptz,
  ADD COLUMN IF NOT EXISTS fixed_by           uuid;

COMMENT ON COLUMN nbfc_financing_offers.negotiation_status IS
  'E-238: open (terms stand; dealer may counter) | dealer_countered (dealer '
  'asked, NBFC to respond) | fixed (NBFC froze the terms — NEITHER side can '
  'change them and the dealer''s Negotiate action disappears; winner selection '
  'is deliberately still allowed). No CHECK — enforced in the route layer.';
COMMENT ON COLUMN nbfc_financing_offers.negotiation_round IS
  'E-238: highest round written for this offer; 0 = never negotiated. The next '
  'round is always this + 1, guarded by nbfc_offer_negotiations_offer_round_uidx.';
COMMENT ON COLUMN nbfc_financing_offers.fixed_at IS
  'E-238: when the NBFC fixed the terms. Set together with negotiation_status='
  '''fixed''; there is no un-fix.';
COMMENT ON COLUMN nbfc_financing_offers.fixed_by IS
  'E-238: users.id of the credit_underwriting / nbfc_admin user who fixed it.';

COMMIT;
