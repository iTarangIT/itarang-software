-- =============================================================================
-- E-332 — DEALER ACCOUNTS: a manual "Lost / closed dealer" with a reason
--         (tracker ID 5, 2026-10-09)
-- =============================================================================
-- WHY. A dealer that has shut shop or stopped buying from us sat in "Dormant"
-- for ever: Dealer Health had no way to say "closed, and why", so the Dormant
-- list mixed dealers worth a call with dealers that are gone.
--
-- WHAT. One NEW table, one row per closed account:
--
--   account_closures (account_id PK → accounts.id, reason, closed_by, closed_at)
--
-- A row = the account is closed; deleting it reopens the account. Closing does
-- NOT touch accounts.status — that column already means something to the
-- dealer portal ('inactive'), and a closed dealer must not lose its login or
-- its history. Dealer Health shows a closed account in its own "Closed" bucket,
-- out of Dormant (src/lib/dealers/accountHealthRules.ts).
--
-- NOT in a column on accounts on purpose: readers reach this table through a
-- to_regclass probe, so code on a database without E-332 reads "nobody is
-- closed" and nothing errors (house rule: a new table, not a mirrored column).
--
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_closures (
    account_id  varchar(255) PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    reason      text NOT NULL,
    closed_by   uuid,
    closed_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE account_closures IS
    'E-332 (ID 5) — a dealer account closed by hand ("Lost / closed dealer"), with the reason. A row = closed; delete it to reopen. accounts.status is untouched.';
