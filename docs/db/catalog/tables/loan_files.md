# `loan_files`

Drizzle export: `loanFiles`
Sandbox row count: `0`
Primary surface: `/api/dealer/loans`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `loan_application_id` | `varchar` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `borrower_name` | `text` | no | — |
| `co_borrower_name` | `text` | yes | — |
| `loan_amount` | `numeric` | no | — |
| `interest_rate` | `numeric` | yes | — |
| `tenure_months` | `int4` | yes | — |
| `emi_amount` | `numeric` | yes | — |
| `down_payment` | `numeric` | yes | — |
| `processing_fee` | `numeric` | yes | — |
| `disbursal_status` | `varchar` | no | yes |
| `disbursed_amount` | `numeric` | yes | — |
| `disbursed_at` | `timestamptz` | yes | — |
| `disbursal_reference` | `text` | yes | — |
| `total_paid` | `numeric` | yes | yes |
| `total_outstanding` | `numeric` | yes | — |
| `next_emi_date` | `timestamptz` | yes | — |
| `emi_schedule` | `jsonb` | yes | — |
| `overdue_amount` | `numeric` | yes | yes |
| `overdue_days` | `int4` | yes | yes |
| `loan_status` | `varchar` | no | yes |
| `closure_date` | `timestamptz` | yes | — |
| `closure_type` | `varchar` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `loan_files_dealer_id_accounts_id_fk` | `dealer_id` | `accounts`(`id`) | no action |
| `loan_files_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | no action |
| `loan_files_loan_application_id_loan_applications_id_fk` | `loan_application_id` | `loan_applications`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `loan_files_dealer_id_idx` | `dealer_id` | no |
| `loan_files_loan_status_idx` | `loan_status` | no |

## Referenced by

### API routes (2)

- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/dealer/loans/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
