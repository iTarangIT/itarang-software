# `other_document_requests`

Drizzle export: `otherDocumentRequests`
Sandbox row count: `4`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `doc_for` | `varchar` | no | yes |
| `doc_label` | `text` | no | — |
| `doc_key` | `varchar` | no | — |
| `is_required` | `bool` | yes | yes |
| `file_url` | `text` | yes | — |
| `upload_status` | `varchar` | no | yes |
| `rejection_reason` | `text` | yes | — |
| `reviewed_by` | `uuid` | yes | — |
| `reviewed_at` | `timestamptz` | yes | — |
| `requested_by` | `uuid` | no | — |
| `uploaded_at` | `timestamptz` | yes | — |
| `upload_token` | `varchar` | yes | — |
| `token_expires_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `other_document_requests_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |
| `other_document_requests_requested_by_users_id_fk` | `requested_by` | `users`(`id`) | no action |
| `other_document_requests_reviewed_by_users_id_fk` | `reviewed_by` | `users`(`id`) | no action |

## Referenced by

### API routes (12)

- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/[leadId]/step3/request-docs/route.ts`
- `src/app/api/admin/kyc/[leadId]/supporting-docs/[requestId]/review/route.ts`
- `src/app/api/admin/lead/[id]/download-profile/route.ts`
- `src/app/api/coborrower/[leadId]/required-other-docs/route.ts`
- `src/app/api/coborrower/[leadId]/submit-other-docs-review/route.ts`
- `src/app/api/coborrower/[leadId]/upload-other-document/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/kyc/[leadId]/requested-docs/route.ts`
- `src/app/api/public/upload-docs/[leadId]/[requestId]/[token]/route.ts`
- `src/app/api/sm/leads/[id]/request-doc/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
