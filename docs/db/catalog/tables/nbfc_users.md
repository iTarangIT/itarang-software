# `nbfc_users`

Drizzle export: `nbfcUsers`
Sandbox row count: `1`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `user_id` | `uuid` | no | — |
| `tenant_id` | `uuid` | no | — |
| `role` | `varchar` | no | yes |
| `created_at` | `timestamptz` | no | yes |

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `nbfc_users_tenant_id_nbfc_tenants_id_fk` | `tenant_id` | `nbfc_tenants`(`id`) | cascade |
| `nbfc_users_user_id_users_id_fk` | `user_id` | `users`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `nbfc_users_tenant_idx` | `tenant_id` | no |
| `nbfc_users_user_tenant_idx` | `user_id`, `tenant_id` | no |

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/nbfc/tenant.ts`
