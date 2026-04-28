# `kyc_verification_metadata`

Drizzle export: `kycVerificationMetadata`
Sandbox row count: `5`
Primary surface: `/api/admin/kyc/queue`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `lead_id` | `text` | no | — |
| `submission_timestamp` | `timestamptz` | no | — |
| `case_type` | `varchar` | yes | — |
| `coupon_code` | `varchar` | yes | — |
| `coupon_status` | `varchar` | no | yes |
| `documents_count` | `int4` | no | yes |
| `consent_verified` | `bool` | no | yes |
| `dealer_edits_locked` | `bool` | no | yes |
| `verification_started_at` | `timestamptz` | yes | — |
| `first_api_execution_at` | `timestamptz` | yes | — |
| `first_api_type` | `varchar` | yes | — |
| `final_decision` | `varchar` | yes | — |
| `final_decision_at` | `timestamptz` | yes | — |
| `final_decision_by` | `uuid` | yes | — |
| `final_decision_notes` | `text` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `lead_id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `kyc_verification_metadata_final_decision_by_users_id_fk` | `final_decision_by` | `users`(`id`) | no action |
| `kyc_verification_metadata_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `kyc_verification_metadata_coupon_idx` | `coupon_code` | no |
| `kyc_verification_metadata_coupon_status_idx` | `coupon_status` | no |

## Referenced by

### API routes (10)

- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts`
- `src/app/api/admin/kyc/[leadId]/bank/verify/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/report/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/score/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/[leadId]/pan/verify/route.ts`
- `src/app/api/admin/kyc/[leadId]/rc/verify/route.ts`
- `src/app/api/admin/kyc/queue/route.ts`
- `src/app/api/kyc/[leadId]/submit-for-verification/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/kyc/admin-workflow.ts`
