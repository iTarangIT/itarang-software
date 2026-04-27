# `scraper_raw`

Drizzle export: `scraperRaw`
Sandbox row count: `38,007`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `text` | no | — |
| `run_id` | `text` | yes | — |
| `raw_data` | `text` | yes | — |
| `created_at` | `timestamp` | yes | yes |

**Primary key:** `id`

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (0)

_No references._

### Library / services (3)

- `src/lib/db/schema.ts`
- `src/lib/scraper/chunkedPipeline.ts`
- `src/lib/scraper/storage/rawStore.ts`
