# `dealer_agreement_signers`

Drizzle export: `dealerAgreementSigners`
Sandbox row count: `28`
Primary surface: `/api/admin/dealer-verifications/[dealerId]/audit-trail`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `application_id` | `uuid` | no | — |
| `provider_document_id` | `text` | yes | — |
| `request_id` | `text` | yes | — |
| `signer_role` | `varchar` | no | — |
| `signer_name` | `text` | no | — |
| `signer_email` | `text` | yes | — |
| `signer_mobile` | `text` | yes | — |
| `signing_method` | `varchar` | yes | — |
| `provider_signer_identifier` | `text` | yes | — |
| `provider_signing_url` | `text` | yes | — |
| `signer_status` | `varchar` | no | yes |
| `signed_at` | `timestamp` | yes | — |
| `last_event_at` | `timestamp` | yes | — |
| `provider_raw_response` | `jsonb` | yes | yes |
| `created_at` | `timestamp` | no | yes |
| `updated_at` | `timestamp` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `dealer_agreement_signers_application_id_dealer_onboarding_applications_id_fk` | `application_id` | `dealer_onboarding_applications`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `dealer_agreement_signers_application_id_idx` | `application_id` | no |
| `dealer_agreement_signers_provider_document_id_idx` | `provider_document_id` | no |
| `dealer_agreement_signers_signer_status_idx` | `signer_status` | no |

## Referenced by

### API routes (3)

- `src/app/api/admin/dealer-verifications/[dealerId]/agreement-tracking/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/audit-trail/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/initiate-agreement/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (4)

- `src/lib/agreement/sync-signers.ts`
- `src/lib/agreement/tracking.ts`
- `src/lib/db/schema.ts`
- `src/lib/email/dealer-notification-recipients.ts`
