-- E-143 — normalise legacy nbfc_users.role values to canonical origination roles
--
-- nbfc_users_role_check (added NOT VALID in E-133) allows only the canonical
-- origination roles: nbfc_admin | credit_underwriting | fi_coordinator |
-- operations | viewer (+ the legacy telemetry roles). The activation flow
-- historically seeded the primary partner-owner with role 'admin', which is NOT
-- in that set. NOT VALID let those rows sit, but any UPDATE to such a row
-- re-checks the new row and fails ("violates check constraint
-- nbfc_users_role_check") — breaking notification-prefs saves and any other
-- per-user write.
--
-- Map the two off-list values to their canonical equivalents:
--   'admin'      → 'nbfc_admin'  (the account owner / NBFC Admin, §7.2)
--   'nbfc_user'  → 'viewer'      (legacy generic user → least-privilege)
--
-- Data-only, additive, idempotent: re-running is a no-op once no rows match.

UPDATE nbfc_users SET role = 'nbfc_admin' WHERE role = 'admin';
UPDATE nbfc_users SET role = 'viewer'     WHERE role = 'nbfc_user';
