# `audit_logs`

Drizzle export: `auditLogs`
Sandbox row count: `566`
Primary surface: `/api/deals`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `entity_type` | `varchar` | no | — |
| `entity_id` | `varchar` | no | — |
| `action` | `varchar` | no | — |
| `changes` | `jsonb` | yes | — |
| `performed_by` | `uuid` | no | — |
| `timestamp` | `timestamp` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `audit_logs_performed_by_users_id_fk` | `performed_by` | `users`(`id`) | no action |

## Referenced by

### API routes (33)

- `src/app/api/admin/dealer-verifications/[dealerId]/audit-trail/route.ts`
- `src/app/api/admin/kyc/[leadId]/coborrower-doc/[docId]/review/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/[leadId]/step3/request-coborrower/route.ts`
- `src/app/api/admin/kyc/[leadId]/step3/request-docs/route.ts`
- `src/app/api/admin/kyc/[leadId]/supporting-docs/[requestId]/review/route.ts`
- `src/app/api/admin/kyc/[leadId]/verification/[verificationId]/action/route.ts`
- `src/app/api/admin/kyc/[leadId]/verification/manual/route.ts`
- `src/app/api/approvals/[id]/approve/route.ts`
- `src/app/api/approvals/[id]/reject/route.ts`
- `src/app/api/cron/sla-monitor/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/dealer/leads/drafts/[leadId]/route.ts`
- `src/app/api/dealer/leads/route.ts`
- `src/app/api/deals/[id]/route.ts`
- `src/app/api/deals/route.ts`
- `src/app/api/disputes/[id]/resolve/route.ts`
- `src/app/api/disputes/route.ts`
- `src/app/api/kyc/[leadId]/save-draft/route.ts`
- `src/app/api/leads/[id]/discard/route.ts`
- `src/app/api/leads/[id]/qualify/route.ts`
- `src/app/api/leads/[id]/route.ts`
- `src/app/api/leads/autofillRequest/route.ts`
- `src/app/api/leads/create/route.ts`
- `src/app/api/leads/draft/[sessionId]/route.ts`
- `src/app/api/leads/route.ts`
- `src/app/api/orders/[id]/approve/route.ts`
- `src/app/api/orders/[id]/grn/route.ts`
- `src/app/api/orders/[id]/payment/route.ts`
- `src/app/api/scraper/leads/[id]/assign/route.ts`
- `src/app/api/scraper/leads/[id]/convert/route.ts`
- `src/app/api/scraper/leads/[id]/status/route.ts`
- `src/app/api/webhooks/bolna/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (2)

- `src/lib/db/schema.ts`
- `src/lib/monitoring.ts`
