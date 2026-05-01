-- E-012 — dealer_nbfc_assignments junction table (BRD §6.0.8 / Sync Audit G-05)
--
-- Links finance-enabled dealers to their approved NBFCs. UNIQUE (dealer_id,
-- nbfc_id) prevents duplicate assignments. status transitions:
--   active <-> suspended; either -> terminated (terminal).
--
-- FK to dealers.id is NOT defined here — it is intentionally enforced at the
-- application layer to mirror the rest of the dealer-consumer fanout
-- migration which is staged separately (G-04 follow-up).

CREATE TABLE IF NOT EXISTS dealer_nbfc_assignments (
  id          SERIAL PRIMARY KEY,
  dealer_id   INTEGER NOT NULL,
  nbfc_id     INTEGER NOT NULL REFERENCES nbfc(id),
  enabled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled_by  INTEGER NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'active',
  notes       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS dealer_nbfc_assignments_dealer_nbfc_uq
  ON dealer_nbfc_assignments (dealer_id, nbfc_id);

CREATE INDEX IF NOT EXISTS dealer_nbfc_assignments_dealer_idx
  ON dealer_nbfc_assignments (dealer_id);

CREATE INDEX IF NOT EXISTS dealer_nbfc_assignments_nbfc_idx
  ON dealer_nbfc_assignments (nbfc_id);
