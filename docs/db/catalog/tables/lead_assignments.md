# `lead_assignments`

Drizzle export: `leadAssignments`
Sandbox row count: `0`
Primary surface: `/api/dashboard/[role]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `lead_owner` | `uuid` | no | — |
| `assigned_by` | `uuid` | no | — |
| `assigned_at` | `timestamptz` | no | yes |
| `lead_actor` | `uuid` | yes | — |
| `actor_assigned_by` | `uuid` | yes | — |
| `actor_assigned_at` | `timestamptz` | yes | — |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `lead_assignments_actor_assigned_by_users_id_fk` | `actor_assigned_by` | `users`(`id`) | no action |
| `lead_assignments_assigned_by_users_id_fk` | `assigned_by` | `users`(`id`) | no action |
| `lead_assignments_lead_actor_users_id_fk` | `lead_actor` | `users`(`id`) | no action |
| `lead_assignments_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | no action |
| `lead_assignments_lead_owner_users_id_fk` | `lead_owner` | `users`(`id`) | no action |

## Referenced by

### API routes (3)

- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/leads/[id]/assign/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (3)

- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-full-dashboard.ts`
