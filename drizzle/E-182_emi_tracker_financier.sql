-- E-182 — EMI Tracker per-loan financier override.
--
-- Adds a free-text `financier` column to nbfc_emi_tracker_overrides so an NBFC
-- operator can label which financier each loan sits under (e.g. "Self Finance",
-- "iTarang Finance", "HEY EV") from the EMI Tracker's per-row Edit control.
--
-- There is no canonical financier field to compute from today (leads only carry
-- a coarse payment_method), so unlike the other override columns this one has no
-- computed fallback: NULL simply renders as "—" until an operator sets it.
--
-- Strictly additive. Idempotent.

ALTER TABLE nbfc_emi_tracker_overrides
  ADD COLUMN IF NOT EXISTS financier text;
