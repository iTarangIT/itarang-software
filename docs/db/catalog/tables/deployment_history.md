# `deployment_history`

Drizzle export: `deploymentHistory`
Sandbox row count: `0`
Primary surface: `/api/dealer/deployed-assets/[assetId]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `deployed_asset_id` | `varchar` | no | — |
| `action` | `varchar` | no | — |
| `description` | `text` | yes | — |
| `performed_by` | `uuid` | no | — |
| `metadata` | `jsonb` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `deployment_history_deployed_asset_id_deployed_assets_id_fk` | `deployed_asset_id` | `deployed_assets`(`id`) | cascade |
| `deployment_history_performed_by_users_id_fk` | `performed_by` | `users`(`id`) | no action |

## Referenced by

### API routes (1)

- `src/app/api/dealer/deployed-assets/[assetId]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/sales/sale-finalization.ts`
