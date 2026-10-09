-- =============================================================================
-- E-334 — DEALER ACCOUNTS: "Order placed" claims and the reorder-reminder log
--         (tracker ID 5, 2026-10-09)
-- =============================================================================
-- WHY. The invoice is the order (ID 5 decision), but accounts can take days to
-- raise one. Until then a dealer who just ordered keeps ageing towards Orange /
-- Red / Dormant, and the salesperson gets nudged about a dealer who has bought.
-- And the agreed reminders (a daily Orange nudge, a monthly Dormant win-back
-- list, a CEO alert when a dealer turns Dormant) need to remember what they
-- already sent, so a restart or a second tick never mails twice.
--
-- WHAT. Two NEW tables:
--
--   account_order_claims  "Order placed": a salesperson records the order date
--                         and PO number. For 15 days from the order date the
--                         dealer's ageing clock counts from the order, not the
--                         last invoice. An invoice for the account dated within
--                         those 15 days confirms the claim and takes over. With
--                         no invoice, ageing resumes from the last invoice and
--                         the claim is listed as "Order claimed, no invoice
--                         raised" until someone withdraws it. Status is never
--                         stored — it is worked out from the invoices each time
--                         (src/lib/accounts/orderClaims.ts), so a late invoice
--                         or a void re-decides it without a backfill.
--
--   account_reminder_log  one row per reminder actually sent: (kind, period,
--                         recipient). The sender claims the row before sending
--                         and deletes it if the send fails, so each reminder
--                         goes out once per period.
--
-- Readers reach both through a to_regclass probe (src/lib/accounts/tables.ts),
-- so code on a database without E-334 behaves as before: no claims, no
-- reminders, the "Order placed" button answers 503.
--
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_order_claims (
    id               bigserial PRIMARY KEY,
    account_id       varchar(255) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    order_date       date NOT NULL,
    po_number        text,
    note             text,
    claimed_by       uuid,
    claimed_at       timestamptz NOT NULL DEFAULT now(),
    withdrawn_at     timestamptz,
    withdrawn_by     uuid,
    withdrawn_reason text
);

CREATE INDEX IF NOT EXISTS account_order_claims_account_idx
    ON account_order_claims (account_id, order_date DESC);

COMMENT ON TABLE account_order_claims IS
    'E-334 (ID 5) — "Order placed": pauses the dealer''s ageing for 15 days from order_date; an invoice in that window confirms it, otherwise it is listed as "order claimed, no invoice raised". Status is computed, never stored.';

CREATE TABLE IF NOT EXISTS account_reminder_log (
    kind        text NOT NULL,
    period_key  text NOT NULL,
    recipient   text NOT NULL,
    dealers     integer NOT NULL DEFAULT 0,
    sent_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, period_key, recipient)
);

COMMENT ON TABLE account_reminder_log IS
    'E-334 (ID 5) — dealer reorder reminders already sent: orange_daily (per owner per IST day), dormant_winback (per recipient per month), dormant_ceo (per dealer per dormancy). Claimed before the send, deleted if it fails.';
