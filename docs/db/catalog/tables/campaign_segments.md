# `campaign_segments`

Drizzle export: `campaignSegments`
Sandbox row count: `0`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `name` | `text` | no | — |
| `description` | `text` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `is_prebuilt` | `bool` | yes | yes |
| `filter_criteria` | `jsonb` | no | — |
| `estimated_audience` | `int4` | yes | — |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `campaign_segments_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `campaign_segments_dealer_id_accounts_id_fk` | `dealer_id` | `accounts`(`id`) | no action |

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
