# `coupon_codes`

Drizzle export: `couponCodes`
Sandbox row count: `24`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `code` | `varchar` | no | — |
| `dealer_id` | `varchar` | no | — |
| `status` | `varchar` | no | yes |
| `credits_available` | `int4` | yes | yes |
| `discount_type` | `varchar` | yes | yes |
| `discount_value` | `numeric` | yes | yes |
| `max_discount_cap` | `numeric` | yes | — |
| `min_amount` | `numeric` | yes | — |
| `used_by_lead_id` | `varchar` | yes | — |
| `used_by` | `uuid` | yes | — |
| `validated_at` | `timestamptz` | yes | — |
| `used_at` | `timestamptz` | yes | — |
| `expires_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `coupon_codes_dealer_id_accounts_id_fk` | `dealer_id` | `accounts`(`id`) | no action |
| `coupon_codes_used_by_lead_id_dealer_leads_id_fk` | `used_by_lead_id` | `dealer_leads`(`id`) | no action |
| `coupon_codes_used_by_users_id_fk` | `used_by` | `users`(`id`) | no action |

## Referenced by

### API routes (18)

- `src/app/api/admin/coupons/[couponId]/release/route.ts`
- `src/app/api/admin/coupons/[couponId]/revoke/route.ts`
- `src/app/api/admin/coupons/batches/[batchId]/download/route.ts`
- `src/app/api/admin/coupons/batches/[batchId]/expire-all/route.ts`
- `src/app/api/admin/coupons/batches/[batchId]/route.ts`
- `src/app/api/admin/coupons/batches/route.ts`
- `src/app/api/admin/coupons/create-batch/route.ts`
- `src/app/api/admin/coupons/reports/route.ts`
- `src/app/api/admin/kyc/[leadId]/cancel-verification/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/cron/expire-coupons/route.ts`
- `src/app/api/dealer/coupons/summary/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/kyc/[leadId]/create-payment-qr/route.ts`
- `src/app/api/kyc/[leadId]/release-coupon/route.ts`
- `src/app/api/kyc/[leadId]/submit-verification/route.ts`
- `src/app/api/kyc/[leadId]/validate-coupon/route.ts`
- `src/app/api/kyc/validate-coupon/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/kyc/admin-workflow.ts`
