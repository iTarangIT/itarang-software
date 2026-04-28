# `scraper_schedules`

Drizzle export: `scraperSchedules`
Sandbox row count: `2`
Primary surface: `/api/scraper/cron`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `frequency` | `varchar` | no | — |
| `day_of_week` | `int4` | yes | — |
| `time_of_day` | `varchar` | no | yes |
| `is_active` | `bool` | no | yes |
| `last_run_at` | `timestamptz` | yes | — |
| `created_by` | `uuid` | no | — |
| `updated_at` | `timestamptz` | no | yes |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `scraper_schedules_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |

## Referenced by

### API routes (2)

- `src/app/api/scraper/cron/route.ts`
- `src/app/api/scraper/schedule/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
