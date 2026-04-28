# `after_sales_records`

Drizzle export: `afterSalesRecords`
Sandbox row count: `0`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | yes | — |
| `warranty_id` | `varchar` | yes | — |
| `battery_serial` | `varchar` | yes | — |
| `customer_id` | `varchar` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `payment_mode` | `varchar` | yes | — |
| `opened_at` | `timestamptz` | no | yes |
| `status` | `varchar` | no | yes |
| `closed_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `after_sales_records_lead_id_leads_id_fk` | `lead_id` | `leads`(`id`) | set null |

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/sales/sale-finalization.ts`
