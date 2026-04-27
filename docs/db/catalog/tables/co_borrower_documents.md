# `co_borrower_documents`

Drizzle export: `coBorrowerDocuments`
Sandbox row count: `0`
Primary surface: `/api/admin/kyc-reviews`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `co_borrower_id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `document_type` | `varchar` | no | — |
| `document_url` | `text` | no | — |
| `file_name` | `text` | yes | — |
| `file_size` | `int4` | yes | — |
| `verification_status` | `varchar` | yes | yes |
| `status` | `varchar` | no | yes |
| `ocr_data` | `jsonb` | yes | — |
| `uploaded_at` | `timestamptz` | no | yes |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `co_borrower_documents_co_borrower_id_co_borrowers_id_fk` | `co_borrower_id` | `co_borrowers`(`id`) | cascade |
| `co_borrower_documents_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Referenced by

### API routes (6)

- `src/app/api/admin/kyc-reviews/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/coborrower-doc/[docId]/review/route.ts`
- `src/app/api/coborrower/[leadId]/documents/route.ts`
- `src/app/api/coborrower/[leadId]/upload-document/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
