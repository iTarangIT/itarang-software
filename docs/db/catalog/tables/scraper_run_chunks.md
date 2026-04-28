# `scraper_run_chunks`

Drizzle export: `scraperRunChunks`
Sandbox row count: `0`
Primary surface: `/api/scraper/runs/[id]/progress`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `text` | no | — |
| `run_id` | `text` | no | — |
| `combination_query` | `text` | no | — |
| `status` | `text` | no | yes |
| `leads_count` | `int4` | yes | yes |
| `error_message` | `text` | yes | — |
| `created_at` | `timestamp` | yes | yes |
| `completed_at` | `timestamp` | yes | — |

**Primary key:** `id`

## Referenced by

### API routes (1)

- `src/app/api/scraper/runs/[id]/progress/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/scraper/chunkedPipeline.ts`
