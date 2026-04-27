# `digilocker_transactions`

Drizzle export: `digilockerTransactions`
Sandbox row count: `69`
Primary surface: `/api/leads/digilocker/initiate`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `verification_id` | `varchar` | yes | — |
| `reference_id` | `varchar` | no | — |
| `decentro_txn_id` | `varchar` | yes | — |
| `session_id` | `varchar` | yes | — |
| `status` | `varchar` | no | yes |
| `customer_phone` | `varchar` | no | — |
| `customer_email` | `varchar` | yes | — |
| `digilocker_url` | `text` | yes | — |
| `short_url` | `text` | yes | — |
| `notification_channel` | `varchar` | no | yes |
| `link_sent_at` | `timestamptz` | yes | — |
| `link_opened_at` | `timestamptz` | yes | — |
| `customer_authorized_at` | `timestamptz` | yes | — |
| `digilocker_raw_response` | `jsonb` | yes | — |
| `aadhaar_extracted_data` | `jsonb` | yes | — |
| `cross_match_result` | `jsonb` | yes | — |
| `aadhaar_pdf` | `bytea` | yes | — |
| `sms_message_id` | `varchar` | yes | — |
| `sms_delivered_at` | `timestamptz` | yes | — |
| `sms_failed_reason` | `text` | yes | — |
| `sms_attempts` | `int4` | no | yes |
| `expires_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `digilocker_transactions_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |
| `digilocker_transactions_verification_id_kyc_verifications_id_fk` | `verification_id` | `kyc_verifications`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `digilocker_transactions_lead_idx` | `lead_id` | no |
| `digilocker_transactions_status_idx` | `status` | no |
| `digilocker_transactions_txn_idx` | `decentro_txn_id` | no |

## Referenced by

### API routes (8)

- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts`
- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/resend-sms/route.ts`
- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/status/[transactionId]/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/kyc/digilocker/callback/[transactionId]/route.ts`
- `src/app/api/leads/digilocker/callback/[transactionId]/route.ts`
- `src/app/api/leads/digilocker/initiate/route.ts`
- `src/app/api/leads/digilocker/status/[transactionId]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (3)

- `src/lib/db/schema.ts`
- `src/lib/kyc/coborrower-verification.ts`
- `src/lib/kyc/pan-verification.ts`
