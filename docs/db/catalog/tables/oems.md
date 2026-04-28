# `oems`

Drizzle export: `oems`
Sandbox row count: `0`
Primary surface: `/api/oems`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `business_entity_name` | `text` | no | — |
| `gstin` | `varchar` | no | — |
| `pan` | `varchar` | yes | — |
| `address_line1` | `text` | yes | — |
| `address_line2` | `text` | yes | — |
| `city` | `text` | yes | — |
| `state` | `text` | yes | — |
| `pincode` | `varchar` | yes | — |
| `bank_name` | `text` | yes | — |
| `bank_account_number` | `text` | no | — |
| `ifsc_code` | `varchar` | no | — |
| `bank_proof_url` | `text` | yes | — |
| `status` | `varchar` | no | yes |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `oems_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |

## Referenced by

### API routes (4)

- `src/app/api/inventory/bulk-upload/route.ts`
- `src/app/api/oems/route.ts`
- `src/app/api/pdi/inventory/route.ts`
- `src/app/api/provisions/route.ts`

### Pages (App Router) (5)

- `src/app/(dashboard)/oem-onboarding/page.tsx`
- `src/app/(dashboard)/provisions/new/page.tsx`
- `src/app/(dashboard)/sales-order-manager/oem-onboarding/page.tsx`
- `src/app/(dashboard)/service-engineer/page.tsx`
- `src/app/(dashboard)/service-engineer/pdi/[id]/page.tsx`

### Library / services (3)

- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-full-dashboard.ts`
