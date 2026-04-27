# `co_borrower_requests`

Drizzle export: `coBorrowerRequests`
Sandbox row count: `3`
Primary surface: `/api/admin/kyc/[leadId]/case-review`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `attempt_number` | `int4` | no | yes |
| `reason` | `text` | yes | — |
| `status` | `varchar` | no | yes |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `co_borrower_requests_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `co_borrower_requests_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `co_borrower_requests_lead_id_idx` | `lead_id` | no |

## Referenced by

### API routes (3)

- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/[leadId]/step3/request-coborrower/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
