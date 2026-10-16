-- =============================================================================
-- E-344 — "BEING WORKED BY" NOTE + DEALER'S LAST ACTION PER CUSTOMER FILE
--         (tracker ID 183, decided 14 Oct, built 16 Oct)
-- =============================================================================
-- WHY. iTarang (Admin / Sales Head from the CRM "Act for dealer" panel, and
-- the iTarang house logins on files the house pushed out) can now work a
-- dealer's customer file. Decided clash rules:
--   * the file shows "being worked by <name>" for 30 minutes after an iTarang
--     action; a second iTarang person is refused while it is live;
--   * the dealer's own action always wins: it clears the note, and an iTarang
--     save made on a copy older than the dealer's last action is refused;
--   * iTarang may act on the dealer's OWN file only after 1 working day with
--     no dealer action — which needs the time of the dealer's last action.
--
-- WHAT. One row per lead (lead_id PK):
--   holder_user_id / holder_name / holder_role / locked_at / expires_at
--       the live iTarang note (NULL = nobody holds the file);
--   dealer_last_action_at / dealer_last_action_by
--       stamped by every gated dealer step (src/lib/leads/actForDealerGuard.ts).
--       When iTarang takes the note first, it is seeded from leads.updated_at
--       so the 1-working-day clock starts from the dealer's last known save,
--       not from iTarang's own write.
-- All time comparisons use Postgres now().
--
-- The code never requires this table: without it the note and the dealer
-- stamp are skipped (logged), the 1-working-day rule falls back to
-- leads.updated_at, and every dealer step works as before.
--
-- Additive + idempotent. Re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_work_locks (
    lead_id                varchar(255) PRIMARY KEY,
    holder_user_id         uuid,
    holder_name            text,
    holder_role            varchar(50),
    locked_at              timestamptz,
    expires_at             timestamptz,
    dealer_last_action_at  timestamptz,
    dealer_last_action_by  uuid,
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_work_locks_expires_idx ON lead_work_locks (expires_at)
    WHERE holder_user_id IS NOT NULL;
