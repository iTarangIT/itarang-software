# `nbfc_tenants`

Drizzle export: `nbfcTenants`
Sandbox row count: `1`
Primary surface: `/api/nbfc/loans/import`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `slug` | `text` | no | — |
| `display_name` | `text` | no | — |
| `contact_email` | `text` | yes | — |
| `aum_inr` | `numeric` | yes | — |
| `active_loans` | `int4` | no | yes |
| `is_active` | `bool` | no | yes |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Referenced by

### API routes (1)

- `src/app/api/nbfc/loans/import/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/nbfc/tenant.ts`
