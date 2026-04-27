# `scraper_runs`

Drizzle export: `scraperRuns`
Sandbox row count: `95`
Primary surface: `/api/scraper/cron`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `triggered_by` | `uuid` | no | — |
| `status` | `varchar` | no | yes |
| `started_at` | `timestamptz` | no | yes |
| `completed_at` | `timestamptz` | yes | — |
| `search_queries` | `jsonb` | yes | — |
| `total_found` | `int4` | yes | yes |
| `new_leads_saved` | `int4` | yes | yes |
| `duplicates_skipped` | `int4` | yes | yes |
| `error_message` | `text` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `scraper_runs_triggered_by_users_id_fk` | `triggered_by` | `users`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `scraper_runs_status_idx` | `status` | no |
| `scraper_runs_triggered_by_idx` | `triggered_by` | no |

## Referenced by

### API routes (2)

- `src/app/api/scraper/cron/route.ts`
- `src/app/api/scraper/runs/[id]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/dealer-scraper-service.ts`
