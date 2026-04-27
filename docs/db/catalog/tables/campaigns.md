# `campaigns`

Drizzle export: `campaigns`
Sandbox row count: `0`
Primary surface: `/api/campaigns`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `name` | `text` | no | — |
| `type` | `varchar` | no | — |
| `status` | `varchar` | no | yes |
| `audience_filter` | `jsonb` | yes | — |
| `message_content` | `text` | yes | — |
| `total_audience` | `int4` | yes | — |
| `cost` | `numeric` | yes | — |
| `created_by` | `uuid` | no | — |
| `started_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `campaigns_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |

## Referenced by

### API routes (3)

- `src/app/api/campaigns/estimate-audience/route.ts`
- `src/app/api/campaigns/route.ts`
- `src/app/api/search/global/route.ts`

### Pages (App Router) (1)

- `src/app/(dashboard)/dealer-portal/campaigns/new/page.tsx`

### Library / services (2)

- `src/lib/consent/consent-pdf-template.ts`
- `src/lib/db/schema.ts`
