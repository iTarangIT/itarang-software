# `provisions`

Drizzle export: `provisions`
Sandbox row count: `0`
Primary surface: `/api/orders`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `oem_id` | `varchar` | no | — |
| `oem_name` | `text` | no | — |
| `products` | `jsonb` | no | — |
| `expected_delivery_date` | `timestamptz` | no | — |
| `status` | `varchar` | no | yes |
| `remarks` | `text` | yes | — |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `provisions_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `provisions_oem_id_oems_id_fk` | `oem_id` | `oems`(`id`) | no action |

## Referenced by

### API routes (6)

- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/orders/route.ts`
- `src/app/api/pdi/inventory/route.ts`
- `src/app/api/provisions/[id]/route.ts`
- `src/app/api/provisions/inventory/route.ts`
- `src/app/api/provisions/route.ts`

### Pages (App Router) (5)

- `src/app/(dashboard)/provisions/[id]/create-order/page.tsx`
- `src/app/(dashboard)/provisions/new/page.tsx`
- `src/app/(dashboard)/provisions/page.tsx`
- `src/app/(dashboard)/sales-order-manager/provisions/page.tsx`
- `src/app/(dashboard)/service-engineer/page.tsx`

### Library / services (4)

- `src/lib/agreement/dealer-agreement-template.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-full-dashboard.ts`
