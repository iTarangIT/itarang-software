# `product_selections`

Drizzle export: `productSelections`
Sandbox row count: `0`
Primary surface: `/api/lead/[id]/step-5/status`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `battery_serial` | `varchar` | yes | — |
| `charger_serial` | `varchar` | yes | — |
| `paraphernalia` | `jsonb` | yes | — |
| `category` | `varchar` | yes | — |
| `sub_category` | `varchar` | yes | — |
| `battery_price` | `numeric` | yes | — |
| `charger_price` | `numeric` | yes | — |
| `paraphernalia_cost` | `numeric` | yes | — |
| `dealer_margin` | `numeric` | yes | — |
| `final_price` | `numeric` | yes | — |
| `payment_mode` | `varchar` | yes | — |
| `admin_decision` | `varchar` | yes | yes |
| `submitted_by` | `uuid` | yes | — |
| `submitted_at` | `timestamptz` | yes | yes |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `product_selections_lead_id_leads_id_fk` | `lead_id` | `leads`(`id`) | cascade |

## Referenced by

### API routes (8)

- `src/app/api/admin/lead/[id]/download-profile/route.ts`
- `src/app/api/admin/lead/[id]/product-selection/route.ts`
- `src/app/api/admin/lead/[id]/reject-loan/route.ts`
- `src/app/api/admin/lead/[id]/sanction-loan/route.ts`
- `src/app/api/lead/[id]/confirm-cash-sale/route.ts`
- `src/app/api/lead/[id]/step-5/confirm-dispatch/route.ts`
- `src/app/api/lead/[id]/step-5/status/route.ts`
- `src/app/api/lead/[id]/submit-product-selection/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
