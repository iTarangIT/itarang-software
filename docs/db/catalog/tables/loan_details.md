# `loan_details`

Drizzle export: `loanDetails`
Sandbox row count: `0`
Primary surface: `/api/dealer/leads`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `lead_id` | `varchar` | yes | — |
| `loan_required` | `bool` | yes | yes |
| `loan_amount` | `numeric` | yes | — |
| `interest_rate` | `numeric` | yes | — |
| `tenure_months` | `int4` | yes | — |
| `processing_fee` | `numeric` | yes | — |
| `emi` | `numeric` | yes | — |
| `down_payment` | `numeric` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `loan_details_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Referenced by

### API routes (1)

- `src/app/api/dealer/leads/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
