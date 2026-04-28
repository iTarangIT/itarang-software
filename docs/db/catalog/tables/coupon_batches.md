# `coupon_batches`

Drizzle export: `couponBatches`
Sandbox row count: `2`
Primary surface: `/api/admin/coupons/batches`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `name` | `varchar` | no | — |
| `dealer_id` | `varchar` | no | — |
| `prefix` | `varchar` | no | — |
| `coupon_value` | `numeric` | no | yes |
| `total_quantity` | `int4` | no | — |
| `expiry_date` | `timestamptz` | yes | — |
| `status` | `varchar` | no | yes |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `coupon_batches_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `coupon_batches_dealer_id_accounts_id_fk` | `dealer_id` | `accounts`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `coupon_batches_dealer_idx` | `dealer_id` | no |
| `coupon_batches_status_idx` | `status` | no |

## Referenced by

### API routes (6)

- `src/app/api/admin/coupons/batches/[batchId]/download/route.ts`
- `src/app/api/admin/coupons/batches/[batchId]/expire-all/route.ts`
- `src/app/api/admin/coupons/batches/[batchId]/route.ts`
- `src/app/api/admin/coupons/batches/route.ts`
- `src/app/api/admin/coupons/create-batch/route.ts`
- `src/app/api/admin/coupons/reports/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
