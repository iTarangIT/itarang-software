-- E-230: validity windows on the OEM reference price book.
--
-- WHY
--   E-226 built the price register but gave a price no END. A row is live until
--   somebody replaces it (effective_to IS NULL), which means the register can
--   only ever answer "what is the price now" and only ever by a human
--   remembering to revise it.
--
--   The requirement (call of 2026-08-06, docs/quotation-approval-flow.md §3) is
--   different in three ways:
--     4. a price carries a validity period — "50,000 is valid until August 1st"
--     6. to change it you ADD A SECOND LINE for the same model starting after
--        the first one ends — "my next pricing for the next period would be
--        52,000"
--     7. before that window expires a notification goes to Admin and CEO
--     9. "your lookup happens according to the validity set on that pricing
--        engine" — the quote is judged against the price in force ON ITS OWN
--        DATE, not against the newest row
--
--   None of that is expressible today: there is no end date, and the partial
--   unique index makes a queued successor literally unrepresentable.
--
-- THE TWO DATES ARE NOT THE SAME DATE
--   valid_until  — the admin's DECLARED expiry. Business intent. "This price is
--                  good until 1 August." Nullable, and NULL means open-ended,
--                  which is exactly every pre-E-230 row: unchanged behaviour.
--   effective_to — the row was SUPERSEDED or cancelled. Bookkeeping. Set when a
--                  revision replaces this line, never chosen by the admin.
--   A row can expire without ever being superseded (valid_until passes, nobody
--   queued a successor) and that is a REAL state — the product silently stops
--   auto-approving, which is precisely what requirement 7's notification exists
--   to prevent. Collapsing the two columns into one would erase the distinction
--   between "we replaced this" and "this ran out", and only the second is an
--   operational failure.
--
-- WHY THE LIVE-UNIQ INDEX IS REPLACED
--   oem_reference_prices_live_uniq is UNIQUE (asset_type, product_id) WHERE
--   effective_to IS NULL — one open row per product, full stop. Requirement 6
--   needs TWO open rows at once: the one in force and the one queued behind it.
--   The index is therefore replaced by one keyed on the window start, which
--   still forbids the degenerate case (two lines for one product starting at the
--   same instant) while permitting the queue.
--
--   NON-OVERLAP ITSELF IS ENFORCED IN THE WRITE TRANSACTION
--   (setOemPrice, src/lib/leads/oemPrices.ts), which locks the product's open
--   rows FOR UPDATE, supersedes the line it is replacing and REFUSES to write a
--   line that would straddle an already-queued one. A btree_gist EXCLUDE
--   constraint would express it in SQL, but it needs CREATE EXTENSION on a
--   shared drifting DB, and this table family enforces its vocabulary at the
--   write path by convention already (E-202, E-218, E-220, E-221, E-226).
--   The index below is the backstop, not the whole guarantee.
--
--   DROPPING AN INDEX IS THE ONE NON-ADDITIVE STATEMENT IN THIS FILE. It
--   destroys no data and no column, and the replacement is created in the same
--   transaction, so there is no window in which a product could acquire two
--   same-instant live rows. Called out here because CLAUDE.md's default is
--   strictly additive and this is the exception.
--
-- REQUIRED: Drizzle names every column of oem_reference_prices in its INSERT
-- (setOemPrice writes through the query builder), so an unapplied DB throws
-- `column "valid_until" does not exist` on the first price saved and the
-- pricing screen is dead, not degraded. The READ path degrades more quietly —
-- see the checklist row.
-- DEPENDS ON E-226_oem_reference_prices — apply that first.
--
-- Additive except for the one index swap, and idempotent — safe to re-run.

BEGIN;

-- ── 1. The declared validity window ──────────────────────────────────────────

ALTER TABLE oem_reference_prices
  ADD COLUMN IF NOT EXISTS valid_until        timestamptz,
  ADD COLUMN IF NOT EXISTS expiry_notified_at timestamptz;

COMMENT ON COLUMN oem_reference_prices.valid_until IS
  'E-230: the admin-declared end of this price''s validity, exclusive. NULL '
  'means open-ended — it stays the reference until something supersedes it, '
  'which is every pre-E-230 row and so preserves E-226 behaviour exactly. '
  'Distinct from effective_to: valid_until is intent, effective_to is '
  '"superseded". A row whose valid_until has passed with effective_to still '
  'NULL is EXPIRED — the product has no reference price and its quotes stop '
  'auto-approving.';

COMMENT ON COLUMN oem_reference_prices.expiry_notified_at IS
  'E-230: when the "this price is about to expire" notification was sent to '
  'Admin and CEO for THIS row. Stamped once per row so the daily sweep nags '
  'once rather than every day until somebody acts. NULL = not yet warned.';

COMMENT ON COLUMN oem_reference_prices.effective_from IS
  'E-230: the start of this price''s validity, inclusive. MAY BE IN THE FUTURE '
  'since E-230 — that is a queued successor line, waiting behind the price '
  'currently in force. Before E-230 it was always now().';

-- ── 2. Room for the queued successor ─────────────────────────────────────────
--
-- Two open rows per product are now legal (in force + queued). What stays
-- illegal is two open rows starting at the same instant, which would make "the
-- price in force" ambiguous again — the exact thing E-226's index existed to
-- prevent.

DROP INDEX IF EXISTS oem_reference_prices_live_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS oem_reference_prices_open_from_uniq
  ON oem_reference_prices (asset_type, product_id, effective_from)
  WHERE effective_to IS NULL;

COMMENT ON INDEX oem_reference_prices_open_from_uniq IS
  'E-230: replaces E-226''s oem_reference_prices_live_uniq. A product may now '
  'hold several OPEN rows — the one in force plus any scheduled successors — '
  'but not two starting at the same instant. Windows are kept from overlapping '
  'by setOemPrice(), which locks these rows FOR UPDATE before writing.';

-- Feeds the daily expiry sweep: open rows carrying a declared end date, not yet
-- warned about. Partial, because the rows with no end date are the majority and
-- can never match.
CREATE INDEX IF NOT EXISTS oem_reference_prices_expiry_idx
  ON oem_reference_prices (valid_until)
  WHERE effective_to IS NULL AND valid_until IS NOT NULL;

-- ── 3. Restate what the table now is ─────────────────────────────────────────

COMMENT ON TABLE oem_reference_prices IS
  'E-226 + E-230: append-only OEM reference price book, now dated. Each open '
  'row (effective_to IS NULL) owns a half-open window '
  '[effective_from, valid_until) for one (asset_type, product_id); the windows '
  'of one product never overlap, so "the price in force at time T" is a lookup '
  'rather than a computation, and a price scheduled to start on 1 August leaves '
  'July''s quotes alone. oem_price is never updated in place — a revision '
  'closes the row it replaces (effective_to) and inserts a new one — so the '
  'number any past quote was judged against is still on disk.';

-- No backfill. Every existing row keeps valid_until NULL, which means
-- open-ended, which is what those rows have meant since E-226. Stamping a
-- guessed expiry on them would start firing "your price is about to lapse"
-- notifications about prices nobody ever gave an end date to.

COMMIT;
