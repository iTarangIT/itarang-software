# `deals`

Drizzle export: `deals`
Sandbox row count: `0`
Primary surface: `/api/deals`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `products` | `jsonb` | no | — |
| `line_total` | `numeric` | no | — |
| `gst_amount` | `numeric` | no | — |
| `transportation_cost` | `numeric` | no | yes |
| `transportation_gst_percent` | `int4` | no | yes |
| `total_payable` | `numeric` | no | — |
| `payment_term` | `varchar` | no | — |
| `credit_period_months` | `int4` | yes | — |
| `deal_status` | `varchar` | no | yes |
| `is_immutable` | `bool` | no | yes |
| `invoice_number` | `text` | yes | — |
| `invoice_url` | `text` | yes | — |
| `invoice_issued_at` | `timestamptz` | yes | — |
| `expires_at` | `timestamptz` | yes | — |
| `expired_by` | `uuid` | yes | — |
| `expired_at` | `timestamptz` | yes | — |
| `expiry_reason` | `text` | yes | — |
| `rejected_by` | `uuid` | yes | — |
| `rejected_at` | `timestamptz` | yes | — |
| `rejection_reason` | `text` | yes | — |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `deals_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `deals_expired_by_users_id_fk` | `expired_by` | `users`(`id`) | no action |
| `deals_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | no action |
| `deals_rejected_by_users_id_fk` | `rejected_by` | `users`(`id`) | no action |

## Referenced by

### API routes (6)

- `src/app/api/approvals/[id]/approve/route.ts`
- `src/app/api/approvals/[id]/reject/route.ts`
- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/deals/[id]/route.ts`
- `src/app/api/deals/route.ts`

### Pages (App Router) (12)

- `src/app/(dashboard)/approvals/page.tsx`
- `src/app/(dashboard)/business-head/approvals/page.tsx`
- `src/app/(dashboard)/business-head/credits/page.tsx`
- `src/app/(dashboard)/business-head/page.tsx`
- `src/app/(dashboard)/deals/%5Bid%5D/page.tsx`
- `src/app/(dashboard)/deals/new/page.tsx`
- `src/app/(dashboard)/deals/page.tsx`
- `src/app/(dashboard)/finance-controller/credits/page.tsx`
- `src/app/(dashboard)/finance-controller/invoices/page.tsx`
- `src/app/(dashboard)/finance-controller/page.tsx`
- `src/app/(dashboard)/sales-head/approvals/page.tsx`
- `src/app/(dashboard)/sales-manager/page.tsx`

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/db/seed-full-dashboard.ts`
