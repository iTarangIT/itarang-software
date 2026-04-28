# `coupon_audit_log`

Drizzle export: `couponAuditLog`
Sandbox row count: `1`
Primary surface: `/api/dealer/leads/[id]`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `coupon_id` | `varchar` | no | — |
| `action` | `varchar` | no | — |
| `old_status` | `varchar` | yes | — |
| `new_status` | `varchar` | yes | — |
| `lead_id` | `varchar` | yes | — |
| `performed_by` | `uuid` | yes | — |
| `ip_address` | `varchar` | yes | — |
| `notes` | `text` | yes | — |
| `created_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `coupon_audit_log_coupon_id_coupon_codes_id_fk` | `coupon_id` | `coupon_codes`(`id`) | no action |
| `coupon_audit_log_lead_id_leads_id_fk` | `lead_id` | `leads`(`id`) | no action |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `coupon_audit_log_action_idx` | `action` | no |
| `coupon_audit_log_coupon_idx` | `coupon_id`, `created_at` | no |

## Referenced by

### API routes (1)

- `src/app/api/dealer/leads/[id]/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/coupon-audit.ts`
- `src/lib/db/schema.ts`
