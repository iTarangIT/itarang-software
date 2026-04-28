# `slas`

Drizzle export: `slas`
Sandbox row count: `0`
Primary surface: `/api/leads`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `workflow_step` | `varchar` | no | — |
| `entity_type` | `varchar` | no | — |
| `entity_id` | `varchar` | no | — |
| `assigned_to` | `uuid` | yes | — |
| `sla_deadline` | `timestamp` | no | — |
| `status` | `varchar` | no | yes |
| `completed_at` | `timestamp` | yes | — |
| `escalated_to` | `uuid` | yes | — |
| `escalated_at` | `timestamp` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `slas_assigned_to_users_id_fk` | `assigned_to` | `users`(`id`) | no action |
| `slas_escalated_to_users_id_fk` | `escalated_to` | `users`(`id`) | no action |

## Referenced by

### API routes (7)

- `src/app/api/cron/sla-monitor/route.ts`
- `src/app/api/leads/[id]/assign/route.ts`
- `src/app/api/leads/route.ts`
- `src/app/api/orders/[id]/approve/route.ts`
- `src/app/api/orders/[id]/payment/route.ts`
- `src/app/api/orders/[id]/upload-pi/route.ts`
- `src/app/api/orders/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (3)

- `src/lib/db/schema.ts`
- `src/lib/db/seed-full-dashboard.ts`
- `src/lib/monitoring.ts`
