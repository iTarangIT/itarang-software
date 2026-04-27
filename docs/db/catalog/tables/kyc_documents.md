# `kyc_documents`

Drizzle export: `kycDocuments`
Sandbox row count: `301`
Primary surface: `/api/admin/kyc-reviews`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `doc_for` | `varchar` | no | yes |
| `doc_type` | `varchar` | no | — |
| `file_url` | `text` | no | — |
| `file_name` | `text` | yes | — |
| `file_size` | `int4` | yes | — |
| `verification_status` | `varchar` | no | yes |
| `failed_reason` | `text` | yes | — |
| `ocr_data` | `jsonb` | yes | — |
| `api_response` | `jsonb` | yes | — |
| `verified_at` | `timestamptz` | yes | — |
| `uploaded_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `kyc_documents_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `kyc_documents_doc_type_idx` | `doc_type` | no |
| `kyc_documents_lead_id_idx` | `lead_id` | no |

## Referenced by

### API routes (13)

- `src/app/api/admin/kyc-reviews/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/ocr/route.ts`
- `src/app/api/admin/lead/[id]/download-profile/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/kyc/[leadId]/complete-and-next/route.ts`
- `src/app/api/kyc/[leadId]/complete-step2/route.ts`
- `src/app/api/kyc/[leadId]/document-status/route.ts`
- `src/app/api/kyc/[leadId]/documents/route.ts`
- `src/app/api/kyc/[leadId]/re-upload/route.ts`
- `src/app/api/kyc/[leadId]/submit-for-verification/route.ts`
- `src/app/api/kyc/[leadId]/submit-verification/route.ts`
- `src/app/api/kyc/[leadId]/upload-document/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/kyc/pan-verification.ts`
