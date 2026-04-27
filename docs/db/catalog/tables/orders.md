# `orders`

Drizzle export: `orders`
Sandbox row count: `0`
Primary surface: `/api/orders`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `provision_id` | `varchar` | no | — |
| `oem_id` | `varchar` | no | — |
| `account_id` | `varchar` | yes | — |
| `order_items` | `jsonb` | no | — |
| `total_amount` | `numeric` | no | — |
| `payment_term` | `varchar` | no | — |
| `credit_period_days` | `int4` | yes | — |
| `pi_url` | `text` | yes | — |
| `pi_amount` | `numeric` | yes | — |
| `invoice_url` | `text` | yes | — |
| `grn_id` | `text` | yes | — |
| `grn_date` | `timestamptz` | yes | — |
| `payment_status` | `varchar` | no | yes |
| `payment_amount` | `numeric` | no | yes |
| `payment_mode` | `varchar` | yes | — |
| `transaction_id` | `text` | yes | — |
| `payment_date` | `timestamptz` | yes | — |
| `order_status` | `varchar` | no | yes |
| `delivery_status` | `varchar` | no | yes |
| `expected_delivery_date` | `timestamptz` | yes | — |
| `actual_delivery_date` | `timestamptz` | yes | — |
| `reorder_tat_days` | `int4` | yes | — |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `orders_account_id_accounts_id_fk` | `account_id` | `accounts`(`id`) | no action |
| `orders_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `orders_oem_id_oems_id_fk` | `oem_id` | `oems`(`id`) | no action |
| `orders_provision_id_provisions_id_fk` | `provision_id` | `provisions`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `orders_created_at_idx` | `created_at` | no |
| `orders_payment_status_idx` | `payment_status` | no |

## Referenced by

### API routes (6)

- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/orders/[id]/approve/route.ts`
- `src/app/api/orders/[id]/grn/route.ts`
- `src/app/api/orders/[id]/payment/route.ts`
- `src/app/api/orders/[id]/upload-pi/route.ts`
- `src/app/api/orders/route.ts`

### Pages (App Router) (15)

- `src/app/(dashboard)/approvals/page.tsx`
- `src/app/(dashboard)/business-head/approvals/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/new/page.tsx`
- `src/app/(dashboard)/dealer-portal/orders/page.tsx`
- `src/app/(dashboard)/disputes/new/page.tsx`
- `src/app/(dashboard)/disputes/page.tsx`
- `src/app/(dashboard)/finance-controller/credits/page.tsx`
- `src/app/(dashboard)/finance-controller/payments/page.tsx`
- `src/app/(dashboard)/orders/[id]/order-details-client.tsx`
- `src/app/(dashboard)/orders/[id]/page.tsx`
- `src/app/(dashboard)/orders/page.tsx`
- `src/app/(dashboard)/provisions/[id]/create-order/page.tsx`
- `src/app/(dashboard)/sales-head/approvals/page.tsx`
- `src/app/(dashboard)/sales-order-manager/orders/page.tsx`
- `src/app/(dashboard)/sales-order-manager/pi-invoices/page.tsx`

### Library / services (5)

- `src/lib/agreement/dealer-agreement-template.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-full-dashboard.ts`
- `src/lib/sales-utils.ts`
