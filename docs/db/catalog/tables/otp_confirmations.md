# `otp_confirmations`

Drizzle export: `otpConfirmations`
Sandbox row count: `0`
Primary surface: `/api/lead/[id]/step-5/status`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `otp_type` | `varchar` | no | yes |
| `otp_hash` | `varchar` | no | — |
| `phone_sent_to` | `varchar` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `expires_at` | `timestamptz` | no | — |
| `send_count` | `int4` | no | yes |
| `attempt_count` | `int4` | no | yes |
| `locked_until` | `timestamptz` | yes | — |
| `is_used` | `bool` | no | yes |
| `used_at` | `timestamptz` | yes | — |
| `used_by` | `uuid` | yes | — |
| `override_by_admin` | `bool` | yes | yes |
| `override_reason` | `text` | yes | — |
| `override_by` | `uuid` | yes | — |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `otp_confirmations_lead_id_leads_id_fk` | `lead_id` | `leads`(`id`) | cascade |

## Referenced by

### API routes (3)

- `src/app/api/lead/[id]/step-5/confirm-dispatch/route.ts`
- `src/app/api/lead/[id]/step-5/send-otp/route.ts`
- `src/app/api/lead/[id]/step-5/status/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
