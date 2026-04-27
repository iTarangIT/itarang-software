# `call_records`

Drizzle export: `callRecords`
Sandbox row count: `37`
Primary surface: `/api/calls`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `session_id` | `text` | yes | — |
| `lead_id` | `varchar` | yes | — |
| `bolna_call_id` | `varchar` | yes | — |
| `status` | `text` | yes | yes |
| `duration_seconds` | `int4` | yes | — |
| `recording_url` | `text` | yes | — |
| `summary` | `text` | yes | — |
| `transcript` | `text` | yes | — |
| `created_at` | `timestamptz` | yes | yes |
| `ended_at` | `timestamptz` | yes | — |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `call_records_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | no action |
| `call_records_session_id_call_sessions_session_id_fk` | `session_id` | `call_sessions`(`session_id`) | no action |

## Referenced by

### API routes (4)

- `src/app/api/calls/route.ts`
- `src/app/api/calls/session/start/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/webhooks/bolna/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/ai-call-service.ts`
- `src/lib/db/schema.ts`
