# `loan_offers`

Drizzle export: `loanOffers`
Sandbox row count: `0`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `financier_name` | `text` | no | — |
| `loan_amount` | `numeric` | no | — |
| `interest_rate` | `numeric` | no | — |
| `tenure_months` | `int4` | no | — |
| `emi` | `numeric` | no | — |
| `processing_fee` | `numeric` | yes | — |
| `notes` | `text` | yes | — |
| `status` | `varchar` | no | yes |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `loan_offers_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `loan_offers_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `loan_offers_lead_id_idx` | `lead_id` | no |

## Referenced by

### API routes (6)

- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/leads/[id]/loan-offers/[offerId]/book/route.ts`
- `src/app/api/leads/[id]/loan-offers/[offerId]/select/route.ts`
- `src/app/api/leads/[id]/loan-offers/route.ts`
- `src/app/api/sm/leads/[id]/loan-offers/route.ts`
- `src/app/api/sm/leads/[id]/submit-options/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
