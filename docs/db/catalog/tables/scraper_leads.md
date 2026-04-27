# `scraper_leads`

Drizzle export: `scraperLeads`
Sandbox row count: `1,040`
Primary surface: `/api/dealer-leads`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `text` | no | — |
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

### API routes (5)

- `src/app/api/dealer-leads/route.ts`
- `src/app/api/scraper-leads/[id]/page.tsx`
- `src/app/api/scraper-leads/[id]/promote/route.ts`
- `src/app/api/scraper-leads/[id]/push-to-lead/route.ts`
- `src/app/api/scraper-leads/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (3)

- `src/lib/ai/bolna_ai/triggerCall.ts`
- `src/lib/db/schema.ts`
- `src/lib/scraper/processing/store.ts`
