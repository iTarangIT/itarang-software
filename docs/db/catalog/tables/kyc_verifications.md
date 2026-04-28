# `kyc_verifications`

Drizzle export: `kycVerifications`
Sandbox row count: `144`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `verification_type` | `varchar` | no | — |
| `applicant` | `varchar` | no | yes |
| `status` | `varchar` | no | yes |
| `api_provider` | `varchar` | yes | — |
| `api_request` | `jsonb` | yes | — |
| `api_response` | `jsonb` | yes | — |
| `failed_reason` | `text` | yes | — |
| `match_score` | `numeric` | yes | — |
| `retry_count` | `int4` | yes | yes |
| `submitted_at` | `timestamptz` | yes | — |
| `completed_at` | `timestamptz` | yes | — |
| `admin_action` | `varchar` | yes | — |
| `admin_action_by` | `uuid` | yes | — |
| `admin_action_at` | `timestamptz` | yes | — |
| `admin_action_notes` | `text` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `kyc_verifications_admin_action_by_users_id_fk` | `admin_action_by` | `users`(`id`) | no action |
| `kyc_verifications_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `kyc_verifications_lead_id_idx` | `lead_id` | no |
| `kyc_verifications_type_idx` | `verification_type` | no |

## Referenced by

### API routes (25)

- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts`
- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/status/[transactionId]/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/report/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/score/route.ts`
- `src/app/api/admin/kyc/[leadId]/coborrower/cibil/score/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/[leadId]/rc/verify/route.ts`
- `src/app/api/admin/kyc/[leadId]/verification/[verificationId]/action/route.ts`
- `src/app/api/admin/kyc/[leadId]/verification/manual/route.ts`
- `src/app/api/admin/lead/[id]/download-profile/route.ts`
- `src/app/api/coborrower/[leadId]/submit-verification/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/kyc/[leadId]/complete-and-next/route.ts`
- `src/app/api/kyc/[leadId]/consent/sync/route.ts`
- `src/app/api/kyc/[leadId]/decentro/aadhaar-otp/route.ts`
- `src/app/api/kyc/[leadId]/decentro/aadhaar-verify/route.ts`
- `src/app/api/kyc/[leadId]/decentro/face-match/route.ts`
- `src/app/api/kyc/[leadId]/decentro/ocr/route.ts`
- `src/app/api/kyc/[leadId]/re-upload/route.ts`
- `src/app/api/kyc/[leadId]/send-consent/route.ts`
- `src/app/api/kyc/[leadId]/submit-verification/route.ts`
- `src/app/api/kyc/[leadId]/verifications/route.ts`
- `src/app/api/kyc/digilocker/callback/[transactionId]/route.ts`
- `src/app/api/leads/digilocker/callback/[transactionId]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (4)

- `src/lib/db/schema.ts`
- `src/lib/kyc/bank-verification.ts`
- `src/lib/kyc/coborrower-verification.ts`
- `src/lib/kyc/pan-verification.ts`
