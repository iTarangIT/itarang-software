# `personal_details`

Drizzle export: `personalDetails`
Sandbox row count: `139`
Primary surface: `/api/dealer/leads`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `lead_id` | `varchar` | yes | — |
| `aadhaar_no` | `varchar` | yes | — |
| `pan_no` | `varchar` | yes | — |
| `dob` | `timestamptz` | yes | — |
| `email` | `text` | yes | — |
| `income` | `numeric` | yes | — |
| `finance_type` | `varchar` | yes | — |
| `financier` | `varchar` | yes | — |
| `asset_type` | `varchar` | yes | — |
| `vehicle_rc` | `varchar` | yes | — |
| `loan_type` | `varchar` | yes | — |
| `father_husband_name` | `text` | yes | — |
| `marital_status` | `varchar` | yes | — |
| `spouse_name` | `text` | yes | — |
| `local_address` | `text` | yes | — |
| `bank_account_number` | `text` | yes | — |
| `bank_ifsc` | `varchar` | yes | — |
| `bank_name` | `text` | yes | — |
| `bank_branch` | `text` | yes | — |
| `dob_confidence` | `numeric` | yes | — |
| `name_confidence` | `numeric` | yes | — |
| `address_confidence` | `numeric` | yes | — |
| `ocr_processed_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `personal_details_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Referenced by

### API routes (14)

- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts`
- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/status/[transactionId]/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/report/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/score/route.ts`
- `src/app/api/admin/kyc/[leadId]/ocr/route.ts`
- `src/app/api/admin/kyc/[leadId]/rc/verify/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/dealer/leads/route.ts`
- `src/app/api/kyc/[leadId]/borrower-details/route.ts`
- `src/app/api/kyc/[leadId]/generate-consent-pdf/route.ts`
- `src/app/api/kyc/digilocker/callback/[transactionId]/route.ts`
- `src/app/api/leads/create/route.ts`
- `src/app/api/leads/in-progress/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/kyc/pan-verification.ts`
