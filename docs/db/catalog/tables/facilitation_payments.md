# `facilitation_payments`

Drizzle export: `facilitationPayments`
Sandbox row count: `0`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `payment_method` | `varchar` | yes | — |
| `facilitation_fee_base_amount` | `numeric` | no | yes |
| `coupon_code` | `varchar` | yes | — |
| `coupon_id` | `varchar` | yes | — |
| `coupon_discount_type` | `varchar` | yes | — |
| `coupon_discount_value` | `numeric` | yes | — |
| `coupon_discount_amount` | `numeric` | yes | yes |
| `facilitation_fee_final_amount` | `numeric` | no | — |
| `razorpay_qr_id` | `varchar` | yes | — |
| `razorpay_qr_status` | `varchar` | yes | — |
| `razorpay_qr_image_url` | `text` | yes | — |
| `razorpay_qr_short_url` | `text` | yes | — |
| `razorpay_qr_expires_at` | `timestamptz` | yes | — |
| `razorpay_payment_id` | `varchar` | yes | — |
| `razorpay_order_id` | `varchar` | yes | — |
| `razorpay_payment_status` | `varchar` | yes | — |
| `utr_number_manual` | `varchar` | yes | — |
| `payment_screenshot_url` | `text` | yes | — |
| `facilitation_fee_status` | `varchar` | no | yes |
| `payment_paid_at` | `timestamptz` | yes | — |
| `payment_verified_at` | `timestamptz` | yes | — |
| `payment_verification_source` | `varchar` | yes | — |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `facilitation_payments_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `facilitation_payments_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `facilitation_payments_lead_id_idx` | `lead_id` | no |
| `facilitation_payments_rzp_qr_idx` | `razorpay_qr_id` | no |
| `facilitation_payments_status_idx` | `facilitation_fee_status` | no |

## Referenced by

### API routes (6)

- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/kyc/[leadId]/create-payment-qr/route.ts`
- `src/app/api/kyc/[leadId]/facilitation-payment/route.ts`
- `src/app/api/kyc/[leadId]/payment-status/route.ts`
- `src/app/api/kyc/[leadId]/regenerate-payment-qr/route.ts`
- `src/app/api/payments/razorpay/webhook/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/kyc/admin-workflow.ts`
