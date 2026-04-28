# `ai_call_logs`

Drizzle export: `aiCallLogs`
Sandbox row count: `0`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `lead_id` | `varchar` | no | — |
| `call_id` | `varchar` | no | — |
| `agent_id` | `varchar` | yes | — |
| `phone_number` | `varchar` | yes | — |
| `transcript` | `text` | yes | — |
| `summary` | `text` | yes | — |
| `recording_url` | `text` | yes | — |
| `call_duration` | `int4` | yes | — |
| `status` | `varchar` | yes | — |
| `provider` | `varchar` | yes | — |
| `started_at` | `timestamptz` | yes | — |
| `ended_at` | `timestamptz` | yes | — |
| `model_used` | `varchar` | yes | — |
| `intent_score` | `int4` | yes | — |
| `intent_reason` | `text` | yes | — |
| `next_action` | `text` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `ai_call_logs_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `ai_call_logs_call_id_idx` | `call_id` | no |
| `ai_call_logs_lead_id_idx` | `lead_id` | no |

## Referenced by

### API routes (3)

- `src/app/api/ceo/ai-dialer/webhook/bolna/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/leads/[id]/call-logs/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/ai/langgraph/lead-qualification-graph.ts`
- `src/lib/db/schema.ts`
