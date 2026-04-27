# `deployed_assets`

Drizzle export: `deployedAssets`
Sandbox row count: `0`
Primary surface: `/api/dealer/assets`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `inventory_id` | `varchar` | no | — |
| `lead_id` | `varchar` | yes | — |
| `deal_id` | `varchar` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `customer_name` | `text` | yes | — |
| `customer_phone` | `varchar` | yes | — |
| `serial_number` | `varchar` | yes | — |
| `asset_category` | `varchar` | yes | — |
| `asset_type` | `varchar` | yes | — |
| `model_type` | `text` | yes | — |
| `deployment_date` | `timestamptz` | no | — |
| `deployment_location` | `text` | yes | — |
| `latitude` | `numeric` | yes | — |
| `longitude` | `numeric` | yes | — |
| `qr_code_url` | `text` | yes | — |
| `qr_code_data` | `text` | yes | — |
| `payment_type` | `varchar` | yes | — |
| `payment_status` | `varchar` | yes | yes |
| `battery_health_percent` | `numeric` | yes | — |
| `last_voltage` | `numeric` | yes | — |
| `last_soc` | `int4` | yes | — |
| `last_telemetry_at` | `timestamptz` | yes | — |
| `telemetry_data` | `jsonb` | yes | — |
| `total_cycles` | `int4` | yes | — |
| `warranty_start_date` | `timestamptz` | yes | — |
| `warranty_end_date` | `timestamptz` | yes | — |
| `warranty_status` | `varchar` | yes | yes |
| `status` | `varchar` | no | yes |
| `last_maintenance_at` | `timestamptz` | yes | — |
| `next_maintenance_due` | `timestamptz` | yes | — |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `deployed_assets_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `deployed_assets_deal_id_deals_id_fk` | `deal_id` | `deals`(`id`) | no action |
| `deployed_assets_dealer_id_accounts_id_fk` | `dealer_id` | `accounts`(`id`) | no action |
| `deployed_assets_inventory_id_inventory_id_fk` | `inventory_id` | `inventory`(`id`) | no action |
| `deployed_assets_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `deployed_assets_dealer_id_idx` | `dealer_id` | no |
| `deployed_assets_status_idx` | `status` | no |

## Referenced by

### API routes (5)

- `src/app/api/dealer/assets/route.ts`
- `src/app/api/dealer/deployed-assets/[assetId]/route.ts`
- `src/app/api/dealer/deployed-assets/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/search/global/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/sales/sale-finalization.ts`
