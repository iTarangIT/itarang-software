# `admin_kyc_reviews`

Drizzle export: `adminKycReviews`
Sandbox row count: `0`
Primary surface: `/api/admin/kyc-reviews`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `review_for` | `varchar` | no | yes |
| `document_id` | `varchar` | yes | — |
| `document_type` | `varchar` | yes | — |
| `outcome` | `varchar` | no | — |
| `rejection_reason` | `text` | yes | — |
| `additional_doc_requested` | `text` | yes | — |
| `reviewer_id` | `uuid` | no | — |
| `reviewer_notes` | `text` | yes | — |
| `reviewed_at` | `timestamptz` | no | yes |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `admin_kyc_reviews_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |
| `admin_kyc_reviews_reviewer_id_users_id_fk` | `reviewer_id` | `users`(`id`) | no action |

## Referenced by

### API routes (3)

- `src/app/api/admin/kyc-reviews/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
