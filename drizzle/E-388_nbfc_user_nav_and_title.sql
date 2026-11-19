-- E-388 — NBFC portal: per-user menu access + designation (Battery Pool, 19 Nov 2026).
--
-- Follows E-387 (parent/child CIBIL approval). The NBFC admin ticks which
-- sidebar menus a user may open (e.g. a child "Credit Verifier" sees only
-- Acquire) and sets the designation shown in the header / profile instead of
-- "NBFC Partner".
--
--   nbfc_users.allowed_nav  jsonb   NULL ⇒ every menu (all existing rows);
--                                   array of menu ids ⇒ only those menus.
--   nbfc_users.title        varchar NULL ⇒ "NBFC Partner" (child default "Credit Verifier").
--
-- Strictly additive + idempotent.

ALTER TABLE nbfc_users ADD COLUMN IF NOT EXISTS allowed_nav jsonb;
ALTER TABLE nbfc_users ADD COLUMN IF NOT EXISTS title varchar(64);
