# `loan_sanctions`

Drizzle export: `loanSanctions`
Sandbox row count: `0`
Primary surface: `/api/lead/[id]/step-5/status`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `product_selection_id` | `varchar` | yes | — |
| `loan_amount` | `numeric` | yes | — |
| `down_payment` | `numeric` | yes | — |
| `file_charge` | `numeric` | yes | — |
| `subvention` | `numeric` | yes | — |
| `disbursement_amount` | `numeric` | yes | — |
| `emi` | `numeric` | yes | — |
| `tenure_months` | `int4` | yes | — |
| `roi` | `numeric` | yes | — |
| `loan_approved_by` | `text` | yes | — |
| `loan_file_number` | `varchar` | yes | — |
| `status` | `varchar` | no | yes |
| `rejection_reason` | `text` | yes | — |
| `sanctioned_by` | `uuid` | yes | — |
| `sanctioned_at` | `timestamptz` | yes | yes |
| `dealer_approved` | `bool` | yes | yes |
| `dealer_approved_at` | `timestamptz` | yes | — |
| `dealer_approved_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `loan_sanctions_lead_id_leads_id_fk` | `lead_id` | `leads`(`id`) | cascade |

## Referenced by

### API routes (7)

- `src/app/api/admin/lead/[id]/download-profile/route.ts`
- `src/app/api/admin/lead/[id]/product-selection/route.ts`
- `src/app/api/admin/lead/[id]/reject-loan/route.ts`
- `src/app/api/admin/lead/[id]/sanction-loan/route.ts`
- `src/app/api/lead/[id]/step-5/confirm-dispatch/route.ts`
- `src/app/api/lead/[id]/step-5/send-otp/route.ts`
- `src/app/api/lead/[id]/step-5/status/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
