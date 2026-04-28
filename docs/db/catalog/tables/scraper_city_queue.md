# `scraper_city_queue`

Drizzle export: `scraperCityQueue`
Sandbox row count: `0`
Primary surface: `/api/scraper/progress`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `text` | no | — |
| `base_query` | `text` | no | — |
| `state` | `text` | no | — |
| `city` | `text` | no | — |
| `full_query` | `text` | no | — |
| `status` | `text` | yes | yes |
| `leads_found` | `int4` | yes | yes |
| `new_leads` | `int4` | yes | yes |
| `duplicates` | `int4` | yes | yes |
| `scraped_at` | `timestamp` | yes | — |
| `created_at` | `timestamp` | yes | yes |

**Primary key:** `id`

## Referenced by

### API routes (1)

- `src/app/api/scraper/progress/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
