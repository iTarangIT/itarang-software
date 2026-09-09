-- =============================================================================
-- E-293 — Refurbish Flow: the NBFC pays the BALANCE (with a payment slip)
--         BEFORE the batteries ship back (2026-09-09).
-- =============================================================================
-- WHAT CHANGED (no new status; the money-leg timing and a proof column):
--
--   * The balance (final bill − confirmed advance) becomes PENDING the moment
--     iTarang sends the final bill (step 13), not when the NBFC signs for the
--     batteries back. `refurbishment_lots.balance_status` was `not_due` until
--     receipt; setFinalCost() now writes `pending` (or `not_due` when nothing
--     is owed).
--   * The NBFC must UPLOAD a payment slip (image/PDF) AND enter the bank
--     reference before it can record the balance. The slip(s) live in
--     `balance_proof_urls` (relative /api/files proxy paths, appended by the
--     lot photo-upload route with target `balance_slip`). `advance_proof_urls`
--     is added for symmetry (target `advance_slip`, optional).
--   * The RETURN DISPATCH (step 14, admin or refurbisher) is REFUSED while the
--     balance is still `pending` — recorded (slip + UTR uploaded) or confirmed
--     unlocks it. Marking the balance received before the batteries are back
--     no longer flips the lot to `settled`; receipt (step 16) settles it.
--
-- Additive and idempotent. Both columns default to '{}' so every existing row
-- reads as "no slip yet"; nothing is backfilled or reinterpreted.
-- =============================================================================

DO $do$
BEGIN
  ALTER TABLE refurbishment_lots
    ADD COLUMN IF NOT EXISTS advance_proof_urls text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS balance_proof_urls text[] NOT NULL DEFAULT '{}';

  COMMENT ON COLUMN refurbishment_lots.advance_proof_urls IS
    'E-293: NBFC-uploaded payment slips for the advance (relative /api/files paths). Optional.';
  COMMENT ON COLUMN refurbishment_lots.balance_proof_urls IS
    'E-293: NBFC-uploaded payment slips for the balance. REQUIRED before the balance can be recorded, and the return dispatch is refused while balance_status = pending.';
  COMMENT ON COLUMN refurbishment_lots.balance_status IS
    'not_due | pending | recorded | confirmed. Since E-293 becomes pending when the final bill is sent (not at receipt); recorded/confirmed unlock the return dispatch.';

  -- DATA: a lot billed under the old timing (final bill sent, batteries still
  -- away, balance owed) has balance_status = not_due because the leg used to
  -- open at receipt. Open it now so the NBFC sees the balance panel and the
  -- return truck is held. Idempotent — the second run matches nothing.
  UPDATE refurbishment_lots
     SET balance_status = 'pending', updated_at = now()
   WHERE final_sent_at IS NOT NULL
     AND balance_status = 'not_due'
     AND coalesce(balance_amount, 0) > 0.005
     AND status IN ('costed', 'ready', 'in_transit_return', 'delivered_back');
  RAISE NOTICE 'E-293: opened the balance leg on % lot(s) billed before this migration', (SELECT count(*) FROM refurbishment_lots WHERE balance_status = 'pending' AND final_sent_at IS NOT NULL AND status IN ('costed','ready','in_transit_return','delivered_back'));
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-293: refurbishment_lots does not exist yet — skip (apply E-292 first)';
END;
$do$;
