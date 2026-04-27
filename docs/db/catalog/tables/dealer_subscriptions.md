# `dealer_subscriptions`

Drizzle export: `dealerSubscriptions`
Sandbox row count: `0`
Primary surface: `/api/user/subscription`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `dealer_id` | `varchar` | no | — |
| `plan_name` | `varchar` | no | — |
| `status` | `varchar` | no | yes |
| `started_at` | `timestamptz` | no | — |
| `expires_at` | `timestamptz` | yes | — |
| `features` | `jsonb` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `dealer_subscriptions_dealer_id_accounts_id_fk` | `dealer_id` | `accounts`(`id`) | no action |

## Referenced by

### API routes (1)

- `src/app/api/user/subscription/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
