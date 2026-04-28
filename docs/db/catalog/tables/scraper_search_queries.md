# `scraper_search_queries`

Drizzle export: `scraperSearchQueries`
Sandbox row count: `6`
Primary surface: `/api/scraper/queries`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `query_text` | `text` | no | — |
| `is_active` | `bool` | no | yes |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `scraper_search_queries_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `sq_active_idx` | `is_active` | no |

## Referenced by

### API routes (2)

- `src/app/api/scraper/queries/[id]/route.ts`
- `src/app/api/scraper/queries/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/dealer-scraper-service.ts`
