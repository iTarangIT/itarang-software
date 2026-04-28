# `kyc_data_audit`

Drizzle export: `kycDataAudit`
Sandbox row count: `0`
Primary surface: `/api/admin/kyc/[leadId]/audit`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `lead_id` | `varchar` | no | — |
| `field_name` | `varchar` | no | — |
| `field_value` | `varchar` | yes | — |
| `data_source` | `varchar` | no | — |
| `entered_by` | `uuid` | no | — |
| `entered_at` | `timestamptz` | no | yes |
| `reason` | `text` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `kyc_data_audit_entered_by_users_id_fk` | `entered_by` | `users`(`id`) | no action |
| `kyc_data_audit_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `kyc_data_audit_lead_idx` | `lead_id` | no |

## Referenced by

### API routes (1)

- `src/app/api/admin/kyc/[leadId]/audit/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (1)

- `src/lib/db/schema.ts`
