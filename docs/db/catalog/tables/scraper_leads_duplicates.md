# `scraper_leads_duplicates`

Drizzle export: `scraperLeadsDuplicates`
Sandbox row count: `7,695`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `text` | no | — |
| `original_lead_id` | `text` | yes | — |
| `name` | `text` | yes | — |
| `phone` | `text` | yes | — |
| `email` | `text` | yes | — |
| `website` | `text` | yes | — |
| `city` | `text` | yes | — |
| `address` | `text` | yes | — |
| `source` | `text` | yes | — |
| `status` | `text` | yes | — |
| `created_at` | `timestamp` | yes | yes |

**Primary key:** `id`

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (0)

_No references._

### Library / services (4)

- `src/lib/db/schema.ts`
- `src/lib/error-utils.ts`
- `src/lib/scraper/processing/store.ts`
- `src/lib/scraper/storage/duplicateStore.ts`
