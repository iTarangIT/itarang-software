# `scraper_dedup_logs`

Drizzle export: `scraperDedupLogs`
Sandbox row count: `292`
Primary surface: `/api/scraper/runs/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `scraper_run_id` | `varchar` | no | — |
| `raw_dealer_name` | `text` | yes | — |
| `raw_phone` | `varchar` | yes | — |
| `raw_location` | `text` | yes | — |
| `raw_source_url` | `text` | yes | — |
| `skip_reason` | `varchar` | no | — |
| `matched_lead_id` | `varchar` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `scraper_dedup_logs_scraper_run_id_scraper_runs_id_fk` | `scraper_run_id` | `scraper_runs`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `ddup_run_idx` | `scraper_run_id` | no |

## Referenced by

### API routes (1)

- `src/app/api/scraper/runs/[id]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/dealer-scraper-service.ts`
