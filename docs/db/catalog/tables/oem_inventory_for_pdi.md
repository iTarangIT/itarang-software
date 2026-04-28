# `oem_inventory_for_pdi`

Drizzle export: `oemInventoryForPDI`
Sandbox row count: `0`
Primary surface: `/api/pdi/submit`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `provision_id` | `varchar` | no | — |
| `inventory_id` | `varchar` | no | — |
| `serial_number` | `varchar` | yes | — |
| `oem_id` | `varchar` | no | — |
| `pdi_status` | `varchar` | no | yes |
| `pdi_record_id` | `varchar` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `oem_inventory_for_pdi_inventory_id_inventory_id_fk` | `inventory_id` | `inventory`(`id`) | no action |
| `oem_inventory_for_pdi_oem_id_oems_id_fk` | `oem_id` | `oems`(`id`) | no action |

## Referenced by

### API routes (4)

- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/pdi/inventory/route.ts`
- `src/app/api/pdi/submit/route.ts`
- `src/app/api/provisions/inventory/route.ts`

### Pages (App Router) (3)

- `src/app/(dashboard)/service-engineer/page.tsx`
- `src/app/(dashboard)/service-engineer/pdi-queue/page.tsx`
- `src/app/(dashboard)/service-engineer/pdi/[id]/page.tsx`

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/db/seed-full-dashboard.ts`
