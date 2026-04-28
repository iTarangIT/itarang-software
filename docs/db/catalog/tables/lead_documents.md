# `lead_documents`

Drizzle export: `leadDocuments`
Sandbox row count: `0`
Primary surface: `/api/documents/upload`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `user_id` | `uuid` | yes | — |
| `doc_type` | `varchar` | no | — |
| `storage_path` | `text` | no | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `lead_documents_dealer_id_accounts_id_fk` | `dealer_id` | `accounts`(`id`) | no action |
| `lead_documents_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |
| `lead_documents_user_id_users_id_fk` | `user_id` | `users`(`id`) | no action |

## Referenced by

### API routes (4)

- `src/app/api/cron/cleanup-leads/route.ts`
- `src/app/api/documents/signed-url/route.ts`
- `src/app/api/documents/upload/route.ts`
- `src/app/api/leads/autofillRequest/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
