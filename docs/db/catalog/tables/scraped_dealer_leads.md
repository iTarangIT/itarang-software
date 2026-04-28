# `scraped_dealer_leads`

Drizzle export: `scrapedDealerLeads`
Sandbox row count: `4,457`
Primary surface: `/api/scraper/leads`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `scraper_run_id` | `varchar` | no | — |
| `dealer_name` | `text` | no | — |
| `phone` | `varchar` | yes | — |
| `location_city` | `varchar` | yes | — |
| `location_state` | `varchar` | yes | — |
| `source_url` | `text` | yes | — |
| `raw_data` | `jsonb` | yes | — |
| `email` | `varchar` | yes | — |
| `gst_number` | `varchar` | yes | — |
| `business_type` | `varchar` | yes | — |
| `products_sold` | `text` | yes | — |
| `website` | `text` | yes | — |
| `quality_score` | `int4` | yes | — |
| `phone_valid` | `bool` | yes | — |
| `assigned_to` | `uuid` | yes | — |
| `assigned_by` | `uuid` | yes | — |
| `assigned_at` | `timestamptz` | yes | — |
| `exploration_status` | `varchar` | no | yes |
| `exploration_notes` | `text` | yes | — |
| `explored_at` | `timestamptz` | yes | — |
| `converted_lead_id` | `varchar` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `scraped_dealer_leads_assigned_by_users_id_fk` | `assigned_by` | `users`(`id`) | no action |
| `scraped_dealer_leads_assigned_to_users_id_fk` | `assigned_to` | `users`(`id`) | no action |
| `scraped_dealer_leads_converted_lead_id_dealer_leads_id_fk` | `converted_lead_id` | `dealer_leads`(`id`) | no action |
| `scraped_dealer_leads_scraper_run_id_scraper_runs_id_fk` | `scraper_run_id` | `scraper_runs`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `sdl_assigned_to_idx` | `assigned_to` | no |
| `sdl_name_city_idx` | `dealer_name`, `location_city` | no |
| `sdl_phone_idx` | `phone` | no |
| `sdl_run_idx` | `scraper_run_id` | no |
| `sdl_source_url_idx` | `source_url` | no |
| `sdl_status_idx` | `exploration_status` | no |

## Referenced by

### API routes (7)

- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/scraper/leads/[id]/assign/route.ts`
- `src/app/api/scraper/leads/[id]/convert/route.ts`
- `src/app/api/scraper/leads/[id]/route.ts`
- `src/app/api/scraper/leads/[id]/status/route.ts`
- `src/app/api/scraper/leads/route.ts`
- `src/app/api/scraper/runs/[id]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (3)

- `src/lib/db/schema.ts`
- `src/lib/dealer-scraper-service.ts`
- `src/lib/scraper/storage/leadStore.ts`
