# `loan_applications`

Drizzle export: `loanApplications`
Sandbox row count: `10`
Primary surface: `/api/dealer/stats`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `applicant_name` | `text` | yes | — |
| `loan_amount` | `numeric` | yes | — |
| `documents_uploaded` | `bool` | yes | yes |
| `company_validation_status` | `varchar` | no | yes |
| `facilitation_fee_status` | `varchar` | no | yes |
| `application_status` | `varchar` | no | yes |
| `facilitation_fee_amount` | `numeric` | yes | — |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `loan_applications_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `loan_applications_lead_id_leads_id_fk` | `lead_id` | `leads`(`id`) | no action |

## Referenced by

### API routes (9)

- `src/app/api/campaigns/estimate-audience/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/dealer/loan-facilitation/[id]/pay-fee/route.ts`
- `src/app/api/dealer/loan-facilitation/[id]/route.ts`
- `src/app/api/dealer/loan-facilitation/queue/route.ts`
- `src/app/api/dealer/loan-facilitation/stats/route.ts`
- `src/app/api/dealer/stats/route.ts`
- `src/app/api/nbfc/loans/import/route.ts`
- `src/app/api/search/global/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
