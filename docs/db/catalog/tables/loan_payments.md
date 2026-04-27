# `loan_payments`

Drizzle export: `loanPayments`
Sandbox row count: `0`
Primary surface: `/api/nbfc/loans/refresh-dpd`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `loan_file_id` | `varchar` | no | — |
| `payment_type` | `varchar` | no | — |
| `amount` | `numeric` | no | — |
| `payment_mode` | `varchar` | yes | — |
| `transaction_id` | `text` | yes | — |
| `payment_date` | `timestamptz` | no | — |
| `emi_month` | `int4` | yes | — |
| `status` | `varchar` | no | yes |
| `receipt_url` | `text` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `loan_payments_loan_file_id_loan_files_id_fk` | `loan_file_id` | `loan_files`(`id`) | cascade |

## Referenced by

### API routes (1)

- `src/app/api/nbfc/loans/refresh-dpd/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
