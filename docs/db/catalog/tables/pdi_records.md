# `pdi_records`

Drizzle export: `pdiRecords`
Sandbox row count: `0`
Primary surface: `/api/pdi/submit`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `oem_inventory_id` | `varchar` | no | — |
| `provision_id` | `varchar` | no | — |
| `service_engineer_id` | `uuid` | no | — |
| `iot_imei_no` | `varchar` | yes | — |
| `physical_condition` | `text` | no | — |
| `discharging_connector` | `varchar` | no | — |
| `charging_connector` | `varchar` | no | — |
| `productor_sticker` | `varchar` | no | — |
| `voltage` | `numeric` | yes | — |
| `soc` | `int4` | yes | — |
| `capacity_ah` | `numeric` | yes | — |
| `resistance_mohm` | `numeric` | yes | — |
| `temperature_celsius` | `numeric` | yes | — |
| `latitude` | `numeric` | no | — |
| `longitude` | `numeric` | no | — |
| `location_address` | `text` | yes | — |
| `product_manual_url` | `text` | yes | — |
| `warranty_document_url` | `text` | yes | — |
| `pdi_photos` | `jsonb` | yes | — |
| `pdi_status` | `varchar` | no | — |
| `failure_reason` | `text` | yes | — |
| `inspected_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `pdi_records_oem_inventory_id_oem_inventory_for_pdi_id_fk` | `oem_inventory_id` | `oem_inventory_for_pdi`(`id`) | no action |
| `pdi_records_service_engineer_id_users_id_fk` | `service_engineer_id` | `users`(`id`) | no action |

## Referenced by

### API routes (2)

- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/pdi/submit/route.ts`

### Pages (App Router) (1)

- `src/app/(dashboard)/service-engineer/pdi-queue/page.tsx`

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/db/seed-full-dashboard.ts`
