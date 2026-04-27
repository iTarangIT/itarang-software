# `bolna_calls`

Drizzle export: `bolnaCalls`
Sandbox row count: `0`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `bolna_call_id` | `varchar` | no | — |
| `lead_id` | `varchar` | yes | — |
| `status` | `varchar` | no | yes |
| `current_phase` | `varchar` | yes | — |
| `started_at` | `timestamptz` | yes | — |
| `ended_at` | `timestamptz` | yes | — |
| `transcript_chunk` | `text` | yes | — |
| `chunk_received_at` | `timestamptz` | yes | — |
| `full_transcript` | `text` | yes | — |
| `transcript_fetched_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `bolna_calls_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `bolna_calls_bolna_call_id_idx` | `bolna_call_id` | no |
| `bolna_calls_lead_id_idx` | `lead_id` | no |
| `bolna_calls_started_at_idx` | `started_at` | no |
| `bolna_calls_status_idx` | `status` | no |

## Referenced by

### API routes (1)

- `src/app/api/dealer/leads/[id]/route.ts`

### Pages (App Router) (1)

- `src/app/(dashboard)/sales-manager/ai-calls/page.tsx`

### Library / services (1)

- `src/lib/db/schema.ts`
