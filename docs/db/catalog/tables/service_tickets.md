# `service_tickets`

Drizzle export: `serviceTickets`
Sandbox row count: `1`
Primary surface: `/api/search/global`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `deployed_asset_id` | `varchar` | yes | — |
| `dealer_id` | `varchar` | no | — |
| `customer_name` | `text` | yes | — |
| `customer_phone` | `varchar` | yes | — |
| `issue_type` | `varchar` | no | — |
| `issue_description` | `text` | no | — |
| `priority` | `varchar` | no | yes |
| `photos_urls` | `jsonb` | yes | — |
| `assigned_to` | `uuid` | yes | — |
| `assigned_at` | `timestamptz` | yes | — |
| `status` | `varchar` | no | yes |
| `resolution_type` | `varchar` | yes | — |
| `resolution_notes` | `text` | yes | — |
| `resolved_by` | `uuid` | yes | — |
| `resolved_at` | `timestamptz` | yes | — |
| `sla_deadline` | `timestamptz` | yes | — |
| `sla_breached` | `bool` | yes | yes |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `service_tickets_assigned_to_users_id_fk` | `assigned_to` | `users`(`id`) | no action |
| `service_tickets_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `service_tickets_dealer_id_accounts_id_fk` | `dealer_id` | `accounts`(`id`) | no action |
| `service_tickets_deployed_asset_id_deployed_assets_id_fk` | `deployed_asset_id` | `deployed_assets`(`id`) | no action |
| `service_tickets_resolved_by_users_id_fk` | `resolved_by` | `users`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `service_tickets_asset_id_idx` | `deployed_asset_id` | no |
| `service_tickets_dealer_id_idx` | `dealer_id` | no |
| `service_tickets_status_idx` | `status` | no |

## Referenced by

### API routes (3)

- `src/app/api/dealer/deployed-assets/[assetId]/route.ts`
- `src/app/api/dealer/service-tickets/route.ts`
- `src/app/api/search/global/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
