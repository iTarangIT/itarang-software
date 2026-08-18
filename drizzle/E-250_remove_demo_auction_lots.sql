-- E-250 — remove the five E-129 demo auction lots.
--
-- WHY THEY GO RATHER THAN GET REPAIRED
--   E-129 inserted DEMO-LOT-001..005 straight into `auction_lots` so the
--   marketplace had something to render before any real lot existed. It
--   predates E-232, so those rows carry:
--
--     · no seller_tenant_id  → invisible the moment the recovery page started
--                              filtering by seller (which it now does), and the
--                              scheduler cannot book a settlement for them:
--                              `closeLotNow` requires a seller and logs
--                              "closed with a winning bid but NO settlement"
--                              as an error on every tick that touches one.
--     · no auction_lot_visibility and no auction_lot_audience rows → no dealer
--                              can see them at all, because the dealer grid
--                              INNER JOINs the audience table.
--     · 7-day and 5-day windows → in breach of the 48-hour hard maximum the
--                              composer and publishLot() both enforce.
--
--   An earlier draft of this file backfilled all three. Probing database-1 on
--   2026-08-18 killed that plan: all five rows are `status='ended'` and expired
--   between 23 and 30 May 2026, and they hold ZERO `auction_lot_items`. The
--   backfill's window-repair statement only touches `status='live'` rows, so it
--   would have been a no-op — leaving five permanently-ended, item-less lots
--   carrying a seller and 940 freshly-written audience rows (47 eligible
--   dealers × 4 channels × 5 lots) that no dealer could ever bid against.
--   Paying 940 rows to keep five dead lots is not a trade worth making.
--
--   The composer + publishLot path now produces real lots, so the demo rows
--   have no remaining job. They go, and the E-129 seed is neutralised in the
--   same change so a replay of the migration folder does not bring them back.
--
-- WHAT THIS DELETES
--   Only rows reachable from a lot whose `lot_code` starts with 'DEMO-LOT-'.
--   Nothing else in any of these tables is touched.
--
--   `auction_lots` has NO foreign keys pointing at it — verified on database-1
--   against information_schema; the constraint list came back empty. So nothing
--   cascades and nothing blocks: every child table must be named explicitly, in
--   child-before-parent order, or the delete silently orphans rows.
--
--   The child list is the full set of columns named `lot_id` in the public
--   schema, not the four the earlier draft listed. `nbfc_auction_lot_actions`
--   (5 demo rows) and `auction_auto_bids` / `nbfc_auction_cancel_requests`
--   (0 today, but reachable) were all missing from it.
--
-- Idempotent: re-running deletes nothing because the parent rows are gone.
--
-- Apply order: sandbox (database-1) first, verify the counts are zero, then
-- production (database-2). Paste into the SQL editor. Never `db:push`.

BEGIN;

-- Children first — there are no FKs, so order is ours to enforce, not the
-- database's.
DELETE FROM auction_auto_bids
 WHERE lot_id IN (SELECT id FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%');

DELETE FROM auction_bids
 WHERE lot_id IN (SELECT id FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%');

DELETE FROM auction_lot_audience
 WHERE lot_id IN (SELECT id FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%');

DELETE FROM auction_lot_visibility
 WHERE lot_id IN (SELECT id FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%');

DELETE FROM auction_lot_items
 WHERE lot_id IN (SELECT id FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%');

DELETE FROM auction_settlements
 WHERE lot_id IN (SELECT id FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%');

DELETE FROM nbfc_auction_cancel_requests
 WHERE lot_id IN (SELECT id FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%');

-- The admin audit trail for these lots. It is an audit log, so deleting from it
-- is normally wrong — but every one of its demo rows describes an action taken
-- against a lot that is itself being removed as never-real. Leaving them behind
-- would be an audit trail pointing at nothing.
DELETE FROM nbfc_auction_lot_actions
 WHERE lot_id IN (SELECT id FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%');

-- No `auction_lot_items` rows exist for these lots, so no `recovery_batteries`
-- row is stranded in state_code='lotted' by this delete. Guarded anyway: if a
-- future replay of E-129 ever gets items attached, release them rather than
-- leaving stock unsellable.
UPDATE recovery_batteries
   SET state_code = 'ready'
 WHERE state_code = 'lotted'
   AND id IN (
     SELECT i.battery_id
       FROM auction_lot_items i
       JOIN auction_lots l ON l.id = i.lot_id
      WHERE l.lot_code LIKE 'DEMO-LOT-%'
   );

-- Parent last.
DELETE FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%';

COMMIT;

-- Verify (expect 0 on every line):
--   SELECT count(*) FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%';
--   SELECT count(*) FROM nbfc_auction_lot_actions a
--     WHERE NOT EXISTS (SELECT 1 FROM auction_lots l WHERE l.id = a.lot_id);
