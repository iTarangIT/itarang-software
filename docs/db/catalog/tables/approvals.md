# `approvals`

Drizzle export: `approvals`
Sandbox row count: `0`
Primary surface: `/api/deals`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `entity_type` | `varchar` | no | — |
| `entity_id` | `varchar` | no | — |
| `level` | `int4` | no | — |
| `approver_role` | `varchar` | no | — |
| `status` | `varchar` | no | yes |
| `approver_id` | `uuid` | yes | — |
| `decision_at` | `timestamptz` | yes | — |
| `rejection_reason` | `text` | yes | — |
| `comments` | `text` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `approvals_approver_id_users_id_fk` | `approver_id` | `users`(`id`) | no action |

## Referenced by

### API routes (8)

- `src/app/api/admin/dealer-verifications/[dealerId]/approve/route.ts`
- `src/app/api/approvals/[id]/approve/route.ts`
- `src/app/api/approvals/[id]/reject/route.ts`
- `src/app/api/approvals/count/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/deals/[id]/route.ts`
- `src/app/api/deals/route.ts`
- `src/app/api/orders/[id]/approve/route.ts`

### Pages (App Router) (8)

- `src/app/(dashboard)/approvals/page.tsx`
- `src/app/(dashboard)/business-head/approvals/page.tsx`
- `src/app/(dashboard)/deals/%5Bid%5D/page.tsx`
- `src/app/(dashboard)/deals/page.tsx`
- `src/app/(dashboard)/orders/[id]/order-details-client.tsx`
- `src/app/(dashboard)/orders/[id]/page.tsx`
- `src/app/(dashboard)/procurement/page.tsx`
- `src/app/(dashboard)/sales-head/approvals/page.tsx`

### Library / services (2)

- `src/lib/agreement/dealer-agreement-template.ts`
- `src/lib/db/schema.ts`
