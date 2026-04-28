# `dealer_leads`

Drizzle export: `dealerLeads`
Sandbox row count: `130`
Primary surface: `/api/ai-dialer`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `text` | no | — |
| `dealer_id` | `text` | yes | — |
| `dealer_name` | `text` | yes | — |
| `phone` | `text` | yes | — |
| `language` | `text` | yes | — |
| `shop_name` | `text` | yes | — |
| `location` | `text` | yes | — |
| `follow_up_history` | `jsonb` | yes | — |
| `current_status` | `text` | yes | — |
| `total_attempts` | `int4` | yes | — |
| `final_intent_score` | `int4` | yes | — |
| `memory` | `jsonb` | yes | — |
| `overall_summary` | `text` | yes | — |
| `created_at` | `timestamp` | yes | yes |
| `next_call_at` | `timestamptz` | yes | — |
| `assigned_to` | `text` | yes | — |
| `approved_by` | `text` | yes | — |
| `rejected_by` | `text` | yes | — |

**Primary key:** `id`

## Referenced by

### API routes (18)

- `src/app/api/ai-dialer/route.ts`
- `src/app/api/ai-dialer/run/route.ts`
- `src/app/api/ai-dialer/status/route.ts`
- `src/app/api/bolna/call-scheduler/route.ts`
- `src/app/api/cron/call/route.ts`
- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/dealer-leads/route.ts`
- `src/app/api/kyc/[leadId]/submit-for-verification/route.ts`
- `src/app/api/kyc/digilocker/callback/[transactionId]/route.ts`
- `src/app/api/leads/[id]/summary/route.ts`
- `src/app/api/leads/assign/route.ts`
- `src/app/api/leads/dealer-lead/assign/route.ts`
- `src/app/api/leads/import/route.ts`
- `src/app/api/scraper-leads/[id]/page.tsx`
- `src/app/api/scraper-leads/[id]/promote/route.ts`
- `src/app/api/scraper-leads/[id]/push-to-lead/route.ts`
- `src/app/api/scraper-leads/converted/download/route.ts`
- `src/app/api/scraper-leads/converted/route.ts`

### Pages (App Router) (3)

- `src/app/(dashboard)/leads/[id]/edit/page.tsx`
- `src/app/(dashboard)/leads/[id]/page.tsx`
- `src/app/(dashboard)/leads/import/route.ts`

### Library / services (6)

- `src/lib/ai/bolna_ai/triggerCall.ts`
- `src/lib/ai/bolna_ai/webhookHandler.ts`
- `src/lib/db/schema.ts`
- `src/lib/sales/sale-finalization.ts`
- `src/lib/scraper/chunkedPipeline.ts`
- `src/lib/scraper/storage/leadStore.ts`
