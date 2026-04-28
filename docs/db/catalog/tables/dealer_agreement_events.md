# `dealer_agreement_events`

Drizzle export: `dealerAgreementEvents`
Sandbox row count: `41`
Primary surface: `/api/admin/dealer-verifications/[dealerId]/audit-trail`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `application_id` | `uuid` | no | — |
| `provider_document_id` | `text` | yes | — |
| `request_id` | `text` | yes | — |
| `event_type` | `varchar` | no | — |
| `signer_role` | `varchar` | yes | — |
| `event_status` | `varchar` | yes | — |
| `event_payload` | `jsonb` | yes | yes |
| `created_at` | `timestamp` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `dealer_agreement_events_application_id_dealer_onboarding_applications_id_fk` | `application_id` | `dealer_onboarding_applications`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `dealer_agreement_events_application_id_idx` | `application_id` | no |
| `dealer_agreement_events_created_at_idx` | `created_at` | no |
| `dealer_agreement_events_provider_document_id_idx` | `provider_document_id` | no |

## Referenced by

### API routes (2)

- `src/app/api/admin/dealer-verifications/[dealerId]/agreement-tracking/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/audit-trail/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (3)

- `src/lib/agreement/sync-signers.ts`
- `src/lib/agreement/tracking.ts`
- `src/lib/db/schema.ts`
