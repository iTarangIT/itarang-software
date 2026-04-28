# `order_disputes`

Drizzle export: `orderDisputes`
Sandbox row count: `0`
Primary surface: `/api/disputes`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `order_id` | `varchar` | no | — |
| `dispute_type` | `varchar` | no | — |
| `description` | `text` | no | — |
| `photos_urls` | `jsonb` | yes | — |
| `assigned_to` | `uuid` | no | — |
| `resolution_status` | `varchar` | no | yes |
| `resolution_details` | `text` | yes | — |
| `action_taken` | `text` | yes | — |
| `resolved_by` | `uuid` | yes | — |
| `resolved_at` | `timestamp` | yes | — |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `order_disputes_assigned_to_users_id_fk` | `assigned_to` | `users`(`id`) | no action |
| `order_disputes_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `order_disputes_order_id_orders_id_fk` | `order_id` | `orders`(`id`) | no action |
| `order_disputes_resolved_by_users_id_fk` | `resolved_by` | `users`(`id`) | no action |

## Referenced by

### API routes (3)

- `src/app/api/disputes/[id]/resolve/route.ts`
- `src/app/api/disputes/[id]/route.ts`
- `src/app/api/disputes/route.ts`

### Pages (App Router) (1)

- `src/app/(dashboard)/disputes/page.tsx`

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/sales-utils.ts`
