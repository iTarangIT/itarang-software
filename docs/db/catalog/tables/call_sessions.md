# `call_sessions`

Drizzle export: `callSessions`
Sandbox row count: `0`
Primary surface: `/api/webhooks/bolna`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `session_id` | `text` | yes | — |
| `status` | `text` | yes | yes |
| `created_at` | `timestamptz` | yes | yes |
| `ended_at` | `timestamptz` | yes | — |

**Primary key:** `id`

## Referenced by

### API routes (2)

- `src/app/api/calls/session/start/route.ts`
- `src/app/api/webhooks/bolna/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/ai-call-service.ts`
- `src/lib/db/schema.ts`
