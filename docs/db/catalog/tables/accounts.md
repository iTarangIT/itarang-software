# `accounts`

Drizzle export: `accounts`
Sandbox row count: `31`
Primary surface: `/api/deals`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `business_entity_name` | `text` | yes | — |
| `gstin` | `varchar` | yes | — |
| `pan` | `varchar` | yes | — |
| `address_line1` | `text` | yes | — |
| `address_line2` | `text` | yes | — |
| `city` | `varchar` | yes | — |
| `state` | `varchar` | yes | — |
| `pincode` | `varchar` | yes | — |
| `bank_name` | `text` | yes | — |
| `bank_account_number` | `text` | yes | — |
| `ifsc_code` | `varchar` | yes | — |
| `bank_proof_url` | `text` | yes | — |
| `dealer_code` | `text` | yes | — |
| `contact_name` | `text` | yes | — |
| `contact_email` | `text` | yes | — |
| `contact_phone` | `varchar` | yes | — |
| `status` | `varchar` | yes | yes |
| `onboarding_status` | `varchar` | yes | — |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | yes |
| `updated_at` | `timestamptz` | yes | yes |

**Primary key:** `id`

## Referenced by

### API routes (14)

- `src/app/api/admin/coupons/batches/[batchId]/route.ts`
- `src/app/api/admin/coupons/batches/route.ts`
- `src/app/api/admin/coupons/create-batch/route.ts`
- `src/app/api/admin/coupons/reports/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/approve/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/route.ts`
- `src/app/api/admin/dealer-verifications/route.ts`
- `src/app/api/admin/decentro/health/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/report/route.ts`
- `src/app/api/approvals/[id]/approve/route.ts`
- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/dealer/leads/route.ts`
- `src/app/api/deals/route.ts`
- `src/app/api/leads/create/route.ts`

### Pages (App Router) (3)

- `src/app/(dashboard)/admin/dealer-verification/page.tsx`
- `src/app/(dashboard)/business-head/credits/page.tsx`
- `src/app/(dashboard)/disputes/page.tsx`

### Library / services (6)

- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-full-dashboard.ts`
- `src/lib/dealer/duplicate-check.ts`
- `src/lib/decentro.ts`
- `src/lib/sales-utils.ts`
