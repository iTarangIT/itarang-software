# `consent_records`

Drizzle export: `consentRecords`
Sandbox row count: `64`
Primary surface: `/api/webhooks/digio`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `consent_for` | `varchar` | no | yes |
| `consent_type` | `varchar` | yes | — |
| `consent_status` | `varchar` | no | yes |
| `consent_token` | `varchar` | yes | — |
| `consent_link_url` | `text` | yes | — |
| `consent_link_sent_at` | `timestamptz` | yes | — |
| `consent_delivery_channel` | `varchar` | yes | — |
| `esign_transaction_id` | `varchar` | yes | — |
| `signed_consent_url` | `text` | yes | — |
| `generated_pdf_url` | `text` | yes | — |
| `signed_at` | `timestamptz` | yes | — |
| `signer_aadhaar_masked` | `varchar` | yes | — |
| `esign_retry_count` | `int4` | yes | yes |
| `esign_error_message` | `text` | yes | — |
| `verified_by` | `uuid` | yes | — |
| `verified_at` | `timestamptz` | yes | — |
| `admin_viewed_by` | `uuid` | yes | — |
| `admin_viewed_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `consent_records_admin_viewed_by_users_id_fk` | `admin_viewed_by` | `users`(`id`) | no action |
| `consent_records_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |
| `consent_records_verified_by_users_id_fk` | `verified_by` | `users`(`id`) | no action |

## Referenced by

### API routes (19)

- `src/app/api/admin/kyc-reviews/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/consent/[consentId]/fetch-pdf/route.ts`
- `src/app/api/admin/kyc/[leadId]/consent/[consentId]/verify/route.ts`
- `src/app/api/admin/kyc/[leadId]/consent/[consentId]/view/route.ts`
- `src/app/api/coborrower/[leadId]/send-consent/route.ts`
- `src/app/api/coborrowerconsent/[leadId]/[token]/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/kyc/[leadId]/complete-and-next/route.ts`
- `src/app/api/kyc/[leadId]/complete-step2/route.ts`
- `src/app/api/kyc/[leadId]/complete-step3/route.ts`
- `src/app/api/kyc/[leadId]/consent/admin/route.ts`
- `src/app/api/kyc/[leadId]/consent/status/route.ts`
- `src/app/api/kyc/[leadId]/consent/sync/route.ts`
- `src/app/api/kyc/[leadId]/generate-consent-pdf/route.ts`
- `src/app/api/kyc/[leadId]/send-consent/route.ts`
- `src/app/api/kyc/[leadId]/upload-signed-consent/route.ts`
- `src/app/api/kyc/[leadId]/verifications/route.ts`
- `src/app/api/webhooks/digio/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (3)

- `src/lib/db/schema.ts`
- `src/lib/digio/sync-consent-status.ts`
- `src/lib/kyc/admin-workflow.ts`
