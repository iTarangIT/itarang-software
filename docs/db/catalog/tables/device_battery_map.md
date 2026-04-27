# `device_battery_map`

Drizzle export: `deviceBatteryMap`
Sandbox row count: `0`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `device_id` | `varchar` | no | — |
| `battery_serial` | `varchar` | yes | — |
| `vehicle_number` | `varchar` | yes | — |
| `vehicle_type` | `varchar` | yes | — |
| `customer_name` | `text` | yes | — |
| `customer_phone` | `varchar` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `status` | `varchar` | yes | yes |
| `installed_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | yes | yes |
| `updated_at` | `timestamptz` | yes | yes |

**Primary key:** `id`

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/telemetry/queries.ts`
