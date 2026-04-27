# `oem_contacts`

Drizzle export: `oemContacts`
Sandbox row count: `0`
Primary surface: `/api/oems`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `oem_id` | `varchar` | no | — |
| `contact_role` | `varchar` | no | — |
| `contact_name` | `text` | no | — |
| `contact_phone` | `varchar` | no | — |
| `contact_email` | `text` | no | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `oem_contacts_oem_id_oems_id_fk` | `oem_id` | `oems`(`id`) | cascade |

## Referenced by

### API routes (1)

- `src/app/api/oems/route.ts`

### Pages (App Router) (1)

- `src/app/(dashboard)/sales-order-manager/oem-onboarding/page.tsx`

### Library / services (1)

- `src/lib/db/schema.ts`
