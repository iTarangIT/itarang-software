# `app_settings`

Drizzle export: `appSettings`
Sandbox row count: `0`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `key` | `text` | no | — |
| `value` | `jsonb` | no | — |
| `updated_at` | `timestamptz` | yes | yes |

**Primary key:** `key`

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/ai/settings.ts`
- `src/lib/db/schema.ts`
