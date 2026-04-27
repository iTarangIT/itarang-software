# `notifications`

Drizzle export: `notifications`
Sandbox row count: `67`
Primary surface: `/api/dealer/notifications`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `text` | no | — |
| `user_id` | `uuid` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `lead_id` | `varchar` | yes | — |
| `type` | `varchar` | no | — |
| `title` | `text` | no | — |
| `message` | `text` | no | — |
| `data` | `jsonb` | yes | — |
| `read` | `bool` | yes | yes |
| `read_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | yes | yes |

**Primary key:** `id`

## Referenced by

### API routes (11)

- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/[leadId]/verification/[verificationId]/action/route.ts`
- `src/app/api/admin/kyc/[leadId]/verification/manual/route.ts`
- `src/app/api/admin/lead/[id]/reject-loan/route.ts`
- `src/app/api/admin/lead/[id]/sanction-loan/route.ts`
- `src/app/api/dealer/notifications/route.ts`
- `src/app/api/kyc/[leadId]/complete-and-next/route.ts`
- `src/app/api/lead/[id]/confirm-cash-sale/route.ts`
- `src/app/api/lead/[id]/step-5/confirm-dispatch/route.ts`
- `src/app/api/lead/[id]/submit-product-selection/route.ts`

### Pages (App Router) (1)

- `src/app/(dashboard)/dealer-portal/loans/page.tsx`

### Library / services (5)

- `src/lib/consent/consent-pdf-template.ts`
- `src/lib/db/schema.ts`
- `src/lib/decentro.ts`
- `src/lib/monitoring.ts`
- `src/lib/notifications.ts`
