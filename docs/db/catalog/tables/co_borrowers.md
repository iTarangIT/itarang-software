# `co_borrowers`

Drizzle export: `coBorrowers`
Sandbox row count: `3`
Primary surface: `/api/admin/kyc-reviews`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `full_name` | `text` | no | — |
| `father_or_husband_name` | `text` | yes | — |
| `dob` | `timestamptz` | yes | — |
| `phone` | `varchar` | no | — |
| `permanent_address` | `text` | yes | — |
| `current_address` | `text` | yes | — |
| `is_current_same` | `bool` | yes | yes |
| `pan_no` | `varchar` | yes | — |
| `aadhaar_no` | `varchar` | yes | — |
| `auto_filled` | `bool` | yes | yes |
| `kyc_status` | `varchar` | yes | yes |
| `consent_status` | `varchar` | yes | yes |
| `verification_submitted_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `co_borrowers_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `co_borrowers_lead_id_idx` | `lead_id` | no |

## Referenced by

### API routes (10)

- `src/app/api/admin/kyc-reviews/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/[leadId]/step3/request-coborrower/route.ts`
- `src/app/api/admin/lead/[id]/download-profile/route.ts`
- `src/app/api/coborrower/[leadId]/route.ts`
- `src/app/api/coborrower/[leadId]/send-consent/route.ts`
- `src/app/api/coborrower/[leadId]/upload-document/route.ts`
- `src/app/api/coborrowerconsent/[leadId]/[token]/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/kyc/coborrower-verification.ts`
