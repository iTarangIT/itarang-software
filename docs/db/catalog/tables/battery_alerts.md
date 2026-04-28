# `battery_alerts`

Drizzle export: `batteryAlerts`
Sandbox row count: `0`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `device_id` | `varchar` | no | — |
| `alert_type` | `varchar` | no | — |
| `severity` | `varchar` | no | — |
| `message` | `text` | yes | — |
| `value` | `numeric` | yes | — |
| `threshold` | `numeric` | yes | — |
| `acknowledged` | `bool` | yes | yes |
| `acknowledged_at` | `timestamptz` | yes | — |
| `acknowledged_by` | `text` | yes | — |
| `created_at` | `timestamptz` | yes | yes |

**Primary key:** `id`

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/telemetry/queries.ts`
