-- ═══════════════════════════════════════════════════════════════════════════
-- E-245 — "Close deal" + message-only negotiation: vocabulary documentation
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THIS MIGRATION IS **OPTIONAL**. It contains no DDL — only COMMENT ON COLUMN
-- refreshes. Read that sentence again before you skip the rest of this header,
-- because it is the opposite of E-238 and E-239, which fail loudly when
-- unapplied. Nothing in the E-245 application code depends on this file.
--
-- WHY THERE IS NO DDL
--   E-245 writes four values that did not exist before:
--
--     nbfc_offer_negotiations.kind            = 'close'
--     nbfc_financing_offers.negotiation_status = 'closed'
--     nbfc_financing_offers.status             = 'withdrawn'
--     nbfc_lead_assignments.status             = 'withdrawn'
--
--   None of them needs a schema change:
--
--   * The first two ride on E-238's deliberate decision to ship NO CHECK
--     constraints on party / kind / negotiation_status (see its header, "WHY NO
--     CHECK CONSTRAINTS ON party / kind / negotiation_status"). The enforcement
--     point is src/lib/nbfc/offer-negotiation.ts, and that is where 'close' and
--     'closed' were added.
--   * 'withdrawn' has been permitted by nbfc_lead_assignments' CHECK since
--     E-131 and by nbfc_financing_offers' CHECK since E-140. Both were written
--     with the later phases in mind and never had a writer until now — E-245 is
--     the FIRST code anywhere in the repo that sets either column to it.
--
--   So the DB is already correct. What is stale is its self-documentation: the
--   E-238 COMMENTs enumerate the old value sets and would tell the next person
--   reading the catalogue that 'close'/'closed' are corruption. That is the
--   whole job of this file.
--
-- IDEMPOTENT: COMMENT ON is a full replace, so re-running is a no-op.
-- ADDITIVE: no ALTER, no DROP, no data touched.

BEGIN;

COMMENT ON COLUMN nbfc_offer_negotiations.kind IS
  'E-238/E-245: offer (NBFC submitted/revised) | counter (dealer asked for a '
  'revision) | fix (NBFC froze the terms) | close (dealer ended the deal with '
  'this lender). No CHECK — enforced in the route layer. Since E-245 a '
  '''counter'' round carries a MESSAGE and never moved numbers: the dealer '
  'states what the customer needs and the NBFC re-prices, so consecutive '
  'dealer rounds diff to nothing by design. Pre-E-245 counters still hold the '
  'dealer''s proposed terms and render as a diff exactly as before.';

COMMENT ON COLUMN nbfc_financing_offers.negotiation_status IS
  'E-238/E-245: open (terms stand; dealer may ask for a revision) | '
  'dealer_countered (dealer asked, NBFC to respond) | fixed (NBFC froze the '
  'terms — NEITHER side can change them and the dealer''s Negotiate action '
  'disappears; winner selection is deliberately still allowed) | closed (the '
  'dealer ended the deal — terminal, set together with status=''withdrawn'' on '
  'this row and on nbfc_lead_assignments). No CHECK — enforced in the route '
  'layer. NOTE a fixed offer can still be CLOSED: fixing freezes the lender''s '
  'numbers, it does not oblige the customer to buy.';

COMMENT ON COLUMN nbfc_financing_offers.status IS
  'E-140/E-245: active | withdrawn. CHECK-constrained to those two since E-140. '
  '''withdrawn'' had no writer until E-245''s POST /api/lead/[id]/close-offer.';

COMMENT ON COLUMN nbfc_lead_assignments.status IS
  'Lifecycle: pending → in_progress → offer_submitted → selected | not_selected '
  '| declined | withdrawn. A1 only writes pending; later phases drive the rest. '
  'E-245: ''withdrawn'' means the DEALER closed the deal with this lender '
  '(decision_reason=''dealer_closed_deal''), which frees one of the two lender '
  'slots so the lead can be re-routed via POST /api/lead/[id]/reselect-financing. '
  'It is NOT the same as ''not_selected'' (lost to a chosen winner), and '
  'select-winner deliberately skips withdrawn/declined rows so it cannot '
  'overwrite that record.';

COMMIT;
