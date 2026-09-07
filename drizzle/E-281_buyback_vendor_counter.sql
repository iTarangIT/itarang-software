------------------------------------------------------------------------------
-- E-281: peakAmp Battery Buyback — iTarang counters the VENDOR (M10 completion).
--
-- WHAT WAS MISSING
--   E-186 built the vendor leg as a one-way street. A vendor could counter our
--   quotation (vendor_thread_lines.counter_price) and iTarang's only two answers
--   were "agree" or "reopen the dealer leg" — and reopening bumps offer_version
--   and forces EVERY open thread to LOST, which is a withdrawal, not a counter.
--   So a desk that wanted to say "no, 78, not 71" had nowhere to say it: the
--   number had no column, the act had no state-machine action, and the only
--   button on the screen blew up the whole auction.
--
--   The dealer leg already solved exactly this. It shipped with dealer_counter
--   only, was found to be asymmetric for the same reason, and gained
--   admin_counter + admin_accept_counter. This file is that fix for the vendor
--   leg. Nothing about the dealer leg changes.
--
-- WHY revised_ask_price AND NOT AN UPDATE TO ask_price
--   ask_price is what the quotation PDF sitting in that vendor's inbox says. It
--   is the opening ask, and it is evidence. Overwriting it would:
--     · render the card backwards — our NEW ask struck through against their OLD
--       counter, because the UI reads ask as "before" and counter as "after";
--     · silently move current_total, which the below-floor banner is computed
--       from, so raising our ask would make a below-floor auction look healthy;
--     · leave the vendor's "Accept" button pointing at their own stale number.
--   A fourth column costs one nullable numeric. The alternative costs the audit.
--
-- WHY awaiting_party AND NOT A NEW buyback_vendor_thread_status VALUE
--   'ITARANG_COUNTERED' was the obvious modelling, and it is the wrong trade.
--   ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it, so
--   this file could no longer be one atomic unit — and every switch over the
--   four-value enum (the status chip, `open`, can_respond, the serializer's
--   VendorThreadStatus union) would need a fifth arm before it compiled.
--
--   The thread status after our counter is still, truthfully, COUNTERED: the
--   negotiation is open and the vendor may answer. What changed is only WHOSE
--   MOVE IT IS, which is one bit and is what this column stores. Keeping the
--   status untouched is why serialize.ts's can_respond and VendorBoard's `open`
--   need no edit — a vendor can answer our counter through the code that already
--   exists.
--
--   Stored, not derived from (responded_at vs a new our_counter_at): both are
--   server clock stamps written by separate HTTP requests, and a UI that renders
--   "your move" from a timestamp comparison is a UI that renders it wrong the one
--   time the clocks tie. Same call E-238 made for negotiation_status.
--
-- WHY negotiation_rounds.party
--   On the DEALER leg offered_by_role='admin' means "iTarang made this offer".
--   On the VENDOR leg it means "an admin TRANSCRIBED what the vendor said" —
--   hearsay, and deliberately distinguished from the vendor saying it themselves
--   (see vendorActionFor's docblock). The moment iTarang writes its OWN vendor-leg
--   round, those two senses of 'admin' collapse into each other inside an
--   INSERT-only audit log whose entire purpose is that someone can later tell
--   them apart.
--
--   party answers a different question from offered_by_role — WHOSE OFFER is
--   this, not who typed it — so it is a new column rather than a new value.
--   NULLABLE with no backfill: every legacy row is unambiguous from what is
--   already there, and readers derive it with
--     COALESCE(party, CASE WHEN leg='VENDOR' THEN 'VENDOR' ELSE upper(offered_by_role) END)
--   A backfill would have to guess, and guessing into an append-only audit table
--   is worse than deriving at read time.
--
-- NO CHECK CONSTRAINTS on awaiting_party / party
--   Vocabulary is enforced in the TS layer and recorded in the COMMENTs below,
--   per E-202/E-218/E-226/E-231/E-232/E-233 and E-238.
--
-- REQUIRED — this one is not optional.
--   src/lib/buyback/vendors.ts reads these tables with raw SQL that names the new
--   columns (threadsForDeal, threadsForVendor, threadContextFor). An unapplied
--   E-281 does not degrade quietly: it takes the admin Vendor Board AND the
--   vendor portal down with `column "awaiting_party" does not exist`.
--   (Drizzle itself is safe here — the only query-builder read of these tables is
--   a single-column select({line_id}) in vendor-response.ts.)
--
-- Additive and idempotent — safe to re-run.
-- Apply with: node --env-file=.env.local      scripts/_apply-e281.mjs   (db-1)
--             node --env-file=.env.production scripts/_apply-e281.mjs   (db-2)
--             ... --verify-only to check without writing.
-- NOT scripts/apply-migration.mjs: it imports `pg`, which is not a dependency of
-- this repo (package.json ships postgres.js) and so that runner cannot start.
------------------------------------------------------------------------------

-- ── 1. Our revised ask, per SKU ──────────────────────────────────────────────
ALTER TABLE vendor_thread_lines
  ADD COLUMN IF NOT EXISTS revised_ask_price NUMERIC(12,2);

COMMENT ON COLUMN vendor_thread_lines.revised_ask_price IS
  'E-281: iTarang''s latest counter to this vendor, per unit. ask_price stays the '
  'OPENING ask the quotation PDF quoted and is never rewritten. Overwritten in '
  'place on each further counter, exactly as counter_price is — the round-by-round '
  'history lives in negotiation_rounds, not here.';

-- ── 2. Whose move it is ──────────────────────────────────────────────────────
ALTER TABLE vendor_threads
  ADD COLUMN IF NOT EXISTS awaiting_party VARCHAR(8) NOT NULL DEFAULT 'VENDOR';

-- A thread that already carries a vendor counter is waiting on US. Without this
-- every in-flight COUNTERED thread would read 'VENDOR' and the new Counter
-- button would be hidden on precisely the deals that motivated this file.
UPDATE vendor_threads
   SET awaiting_party = 'ITARANG'
 WHERE status = 'COUNTERED'
   AND awaiting_party = 'VENDOR';

COMMENT ON COLUMN vendor_threads.awaiting_party IS
  'E-281: VENDOR (the ball is in theirs — we sent the quotation, or countered '
  'their counter) | ITARANG (they countered; the desk owes a reply). The thread '
  'STATUS is unchanged by an iTarang counter — it is still COUNTERED, because the '
  'negotiation is still open — so this column, not the status enum, is what says '
  'whose move it is. No CHECK: enforced in the route layer.';

-- ── 3. Whose offer a round is ────────────────────────────────────────────────
ALTER TABLE negotiation_rounds
  ADD COLUMN IF NOT EXISTS party VARCHAR(8);

COMMENT ON COLUMN negotiation_rounds.party IS
  'E-281: DEALER | VENDOR | ITARANG — whose OFFER this round is, as against '
  'offered_by_role, which is who typed it. The two differ only on the vendor leg, '
  'where offered_by_role=''admin'' means an admin transcribed the vendor''s email. '
  'NULL on every pre-E-281 row and deliberately not backfilled; readers derive it '
  'as COALESCE(party, CASE WHEN leg=''VENDOR'' THEN ''VENDOR'' ELSE upper(offered_by_role) END). '
  'No CHECK: enforced in the route layer.';
