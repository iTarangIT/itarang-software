# `dealer_onboarding_documents`

Drizzle export: `dealerOnboardingDocuments`
Sandbox row count: `318`
Primary surface: `/api/dealer-onboarding/save`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `application_id` | `uuid` | no | — |
| `document_type` | `varchar` | no | — |
| `bucket_name` | `text` | no | — |
| `storage_path` | `text` | no | — |
| `file_name` | `text` | no | — |
| `file_url` | `text` | yes | — |
| `mime_type` | `varchar` | yes | — |
| `file_size` | `int8` | yes | — |
| `uploaded_by` | `uuid` | yes | — |
| `uploaded_at` | `timestamp` | no | yes |
| `doc_status` | `varchar` | no | yes |
| `verification_status` | `varchar` | yes | yes |
| `verified_at` | `timestamp` | yes | — |
| `verified_by` | `uuid` | yes | — |
| `rejection_reason` | `text` | yes | — |
| `extracted_data` | `jsonb` | yes | yes |
| `api_verification_results` | `jsonb` | yes | yes |
| `metadata` | `jsonb` | yes | yes |
| `created_at` | `timestamp` | no | yes |
| `updated_at` | `timestamp` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `dealer_onboarding_documents_application_id_dealer_onboarding_applications_id_fk` | `application_id` | `dealer_onboarding_applications`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `dealer_onboarding_documents_application_id_idx` | `application_id` | no |

## Referenced by

### API routes (5)

- `src/app/api/admin/dealer-verifications/[dealerId]/route.ts`
- `src/app/api/admin/dealer-verifications/export/route.ts`
- `src/app/api/admin/dealer-verifications/route.ts`
- `src/app/api/dealer-onboarding/save/route.ts`
- `src/app/api/dealer/onboarding/submit/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
