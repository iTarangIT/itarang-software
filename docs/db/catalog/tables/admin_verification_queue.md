# `admin_verification_queue`

Drizzle export: `adminVerificationQueue`
Sandbox row count: `5`
Primary surface: `/api/admin/kyc/queue`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `queue_type` | `varchar` | no | yes |
| `lead_id` | `text` | no | — |
| `priority` | `varchar` | no | yes |
| `assigned_to` | `uuid` | yes | — |
| `submitted_by` | `uuid` | yes | — |
| `status` | `varchar` | no | yes |
| `submitted_at` | `timestamptz` | yes | — |
| `reviewed_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `admin_verification_queue_assigned_to_users_id_fk` | `assigned_to` | `users`(`id`) | no action |
| `admin_verification_queue_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |
| `admin_verification_queue_submitted_by_users_id_fk` | `submitted_by` | `users`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `admin_verification_queue_assigned_idx` | `assigned_to` | no |
| `admin_verification_queue_created_idx` | `created_at` | no |
| `admin_verification_queue_lead_idx` | `lead_id` | no |
| `admin_verification_queue_status_idx` | `status` | no |

## Referenced by

### API routes (4)

- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/queue/route.ts`
- `src/app/api/kyc/[leadId]/submit-for-verification/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/kyc/admin-workflow.ts`
