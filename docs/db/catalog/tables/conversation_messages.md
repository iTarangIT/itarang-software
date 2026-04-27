# `conversation_messages`

Drizzle export: `conversationMessages`
Sandbox row count: `164`
Primary surface: `/api/webhooks/bolna`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `call_record_id` | `varchar` | yes | — |
| `role` | `text` | yes | — |
| `message` | `text` | yes | — |
| `timestamp` | `timestamptz` | yes | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `conversation_messages_call_record_id_call_records_id_fk` | `call_record_id` | `call_records`(`id`) | no action |

## Referenced by

### API routes (1)

- `src/app/api/webhooks/bolna/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/ai-call-service.ts`
- `src/lib/db/schema.ts`
