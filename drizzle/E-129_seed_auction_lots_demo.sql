-- E-129 — Seed demo auction lots so /nbfc/recovery shows live marketplace cards.
--
-- BRD §6.1.7: the Auction Marketplace section reads auction_lots WHERE
-- status='live' AND ends_at > now(). Until a "publish to auction" flow is run
-- end-to-end against a fresh tenant, the table is empty and the page renders
-- "0 live lots". This seed gives the marketplace 5 deterministic demo lots
-- with staggered closing times so the live countdown UI is exercised.
--
-- Strictly additive. Idempotent — INSERT … ON CONFLICT (lot_code) DO NOTHING.
-- Stable lot_codes ('DEMO-LOT-001'..'DEMO-LOT-005') guarantee re-runs are no-ops.
-- ends_at is computed from now() so a re-run after the demo lots have expired
-- naturally extends them again only if the lot_code rows are deleted first.

INSERT INTO auction_lots
  (lot_code,        capacity,    avg_soh, age_months, quantity, base_price, bid_increment, ends_at,                  status)
VALUES
  ('DEMO-LOT-001',  '60V / 30Ah', 88.50,  14,         1,        28500.00,   500.00,        now() + interval '7 days', 'live'),
  ('DEMO-LOT-002',  '48V / 24Ah', 82.10,  22,         1,        18200.00,   500.00,        now() + interval '3 days', 'live'),
  ('DEMO-LOT-003',  '72V / 40Ah', 79.40,  18,         2,        46000.00,  1000.00,        now() + interval '1 day',  'live'),
  ('DEMO-LOT-004',  '60V / 30Ah', 74.20,  28,         1,        14800.00,   250.00,        now() + interval '12 hours','live'),
  ('DEMO-LOT-005',  '48V / 20Ah', 91.30,  9,          3,        51000.00,  1000.00,        now() + interval '5 days', 'live')
ON CONFLICT (lot_code) DO NOTHING;
