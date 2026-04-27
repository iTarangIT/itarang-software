# `dealer_onboarding_applications`

Drizzle export: `dealerOnboardingApplications`
Sandbox row count: `33`
Primary surface: `/api/dealer/leads`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `dealer_user_id` | `uuid` | yes | — |
| `company_name` | `text` | no | — |
| `company_type` | `text` | yes | — |
| `gst_number` | `text` | yes | — |
| `pan_number` | `text` | yes | — |
| `cin_number` | `text` | yes | — |
| `business_address` | `jsonb` | yes | yes |
| `registered_address` | `jsonb` | yes | yes |
| `finance_enabled` | `bool` | yes | yes |
| `onboarding_status` | `varchar` | no | yes |
| `review_status` | `varchar` | yes | yes |
| `submitted_at` | `timestamp` | yes | — |
| `approved_at` | `timestamp` | yes | — |
| `rejected_at` | `timestamp` | yes | — |
| `rejection_reason` | `text` | yes | — |
| `admin_notes` | `text` | yes | — |
| `is_branch_dealer` | `bool` | no | yes |
| `created_at` | `timestamp` | no | yes |
| `updated_at` | `timestamp` | no | yes |
| `owner_name` | `text` | yes | — |
| `owner_phone` | `text` | yes | — |
| `owner_landline` | `varchar` | yes | — |
| `owner_email` | `text` | yes | — |
| `sales_manager_name` | `text` | yes | — |
| `sales_manager_email` | `text` | yes | — |
| `sales_manager_mobile` | `varchar` | yes | — |
| `itarang_signatory_1_name` | `text` | yes | — |
| `itarang_signatory_1_email` | `text` | yes | — |
| `itarang_signatory_1_mobile` | `varchar` | yes | — |
| `itarang_signatory_2_name` | `text` | yes | — |
| `itarang_signatory_2_email` | `text` | yes | — |
| `itarang_signatory_2_mobile` | `varchar` | yes | — |
| `bank_name` | `text` | yes | — |
| `account_number` | `text` | yes | — |
| `beneficiary_name` | `text` | yes | — |
| `ifsc_code` | `text` | yes | — |
| `correction_remarks` | `text` | yes | — |
| `rejection_remarks` | `text` | yes | — |
| `dealer_account_status` | `varchar` | yes | yes |
| `dealer_code` | `text` | yes | — |
| `agreement_status` | `varchar` | yes | — |
| `agreement_language` | `varchar` | no | yes |
| `completion_status` | `varchar` | yes | — |
| `provider_document_id` | `text` | yes | — |
| `request_id` | `text` | yes | — |
| `provider_signing_url` | `text` | yes | — |
| `provider_raw_response` | `jsonb` | yes | — |
| `stamp_status` | `varchar` | yes | — |
| `stamp_certificate_ids` | `jsonb` | yes | yes |
| `last_action_timestamp` | `timestamp` | yes | — |
| `signed_at` | `timestamp` | yes | — |
| `signed_agreement_url` | `text` | yes | — |
| `signed_agreement_storage_path` | `text` | yes | — |
| `audit_trail_url` | `text` | yes | — |
| `audit_trail_storage_path` | `text` | yes | — |

**Primary key:** `id`

## Referenced by

### API routes (25)

- `src/app/api/admin/dealer-verifications/[dealerId]/agreement-tracking/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/approve/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/audit-trail/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/cancel-agreement/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/download-signed-agreement/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/duplicate-check/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/fetch-audit-trail/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/initiate-agreement/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/re-initiate-agreement/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/refresh-agreement/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/reject/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/request-correction/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/route.ts`
- `src/app/api/admin/dealer-verifications/export/route.ts`
- `src/app/api/admin/dealer-verifications/route.ts`
- `src/app/api/dealer-onboarding/[applicationId]/route.ts`
- `src/app/api/dealer-onboarding/list/route.ts`
- `src/app/api/dealer-onboarding/save/route.ts`
- `src/app/api/dealer/leads/drafts/route.ts`
- `src/app/api/dealer/leads/route.ts`
- `src/app/api/dealer/onboarding/submit/route.ts`
- `src/app/api/debug/alter-onboarding-table/route.ts`
- `src/app/api/debug/create-onboarding-tables/route.ts`
- `src/app/api/debug/onboarding-db/route.ts`
- `src/app/api/leads/create/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (8)

- `src/lib/agreement/providerRaw.ts`
- `src/lib/db/schema.ts`
- `src/lib/dealer-onboarding.ts`
- `src/lib/dealer/duplicate-check.ts`
- `src/lib/digio/ensure-audit-trail.ts`
- `src/lib/digio/ensure-signed-agreement.ts`
- `src/lib/email/dealer-notification-recipients.ts`
- `src/lib/supabase/identity.ts`
