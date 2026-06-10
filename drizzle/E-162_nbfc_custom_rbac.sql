-- E-162 — NBFC Custom RBAC (BRD Addendum V0.3.1 §15.8, Option III hybrid).
--
-- Additive + NON-BREAKING. The five system roles remain CODE defaults
-- (src/lib/nbfc/permissions.ts); they are NOT seeded here, so there is nothing
-- to drift. These tables hold only TENANT-SCOPED CUSTOM roles cloned from a
-- system role and tweaked. A user opts into a custom role via
-- nbfc_users.role_id; until then (every existing row) they keep running on
-- their nbfc_users.role string default. Existing role checks are unaffected.

-- Custom roles, one set per tenant. `base_role` is the system role this was
-- cloned from — used for the legacy coarse role checks so they behave like the
-- base while the fine-grained permissions govern the new can() gates.
CREATE TABLE IF NOT EXISTS nbfc_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES nbfc_tenants(id),
  name        varchar(64) NOT NULL,
  description text,
  base_role   varchar(32) NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nbfc_roles_tenant_idx ON nbfc_roles (tenant_id, is_active);

-- Permissions granted to a custom role. permission_key is validated against the
-- code catalogue at write time (no FK to keep the catalogue code-owned).
CREATE TABLE IF NOT EXISTS nbfc_role_permissions (
  role_id        uuid NOT NULL REFERENCES nbfc_roles(id) ON DELETE CASCADE,
  permission_key varchar(64) NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

-- Opt-in pointer from a user to a custom role. NULL (all existing rows) ⇒ the
-- user runs on their nbfc_users.role string default — non-breaking.
ALTER TABLE nbfc_users
  ADD COLUMN IF NOT EXISTS role_id uuid;

COMMENT ON TABLE nbfc_roles IS
  'Tenant-scoped custom RBAC roles cloned from a system role (E-162). System roles themselves are code defaults.';
COMMENT ON COLUMN nbfc_users.role_id IS
  'Optional custom role (nbfc_roles.id). NULL ⇒ use the nbfc_users.role string default (E-162).';
