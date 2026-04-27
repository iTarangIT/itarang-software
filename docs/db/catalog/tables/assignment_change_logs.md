# `assignment_change_logs`

Drizzle export: `assignmentChangeLogs`
Sandbox row count: `0`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `change_type` | `varchar` | no | — |
| `old_user_id` | `uuid` | yes | — |
| `new_user_id` | `uuid` | yes | — |
| `changed_by` | `uuid` | no | — |
| `change_reason` | `text` | yes | — |
| `changed_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `assignment_change_logs_changed_by_users_id_fk` | `changed_by` | `users`(`id`) | no action |
| `assignment_change_logs_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | no action |
| `assignment_change_logs_new_user_id_users_id_fk` | `new_user_id` | `users`(`id`) | no action |
| `assignment_change_logs_old_user_id_users_id_fk` | `old_user_id` | `users`(`id`) | no action |

## Referenced by

### API routes (2)

- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/leads/[id]/assign/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
