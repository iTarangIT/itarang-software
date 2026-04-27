# `users`

Drizzle export: `users`
Sandbox row count: `6`
Primary surface: `/api/disputes`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | — |
| `email` | `text` | no | — |
| `name` | `text` | no | — |
| `role` | `varchar` | no | — |
| `dealer_id` | `varchar` | yes | — |
| `phone` | `text` | yes | — |
| `avatar_url` | `text` | yes | — |
| `password_hash` | `text` | yes | — |
| `must_change_password` | `bool` | no | yes |
| `is_active` | `bool` | no | yes |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Referenced by

### API routes (20)

- `src/app/api/admin/dealer-verifications/[dealerId]/approve/route.ts`
- `src/app/api/admin/kyc-reviews/route.ts`
- `src/app/api/auth/change-password/route.ts`
- `src/app/api/cron/sla-monitor/route.ts`
- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/dealer/deployed-assets/route.ts`
- `src/app/api/dealer/leads/route.ts`
- `src/app/api/dealer/notifications/route.ts`
- `src/app/api/dealer/service-tickets/route.ts`
- `src/app/api/dealer/stats/route.ts`
- `src/app/api/disputes/route.ts`
- `src/app/api/kyc/[leadId]/generate-consent-pdf/route.ts`
- `src/app/api/kyc/[leadId]/send-consent/route.ts`
- `src/app/api/scraper/leads/[id]/assign/route.ts`
- `src/app/api/scraper/leads/route.ts`
- `src/app/api/scraper/queries/route.ts`
- `src/app/api/scraper/runs/[id]/route.ts`
- `src/app/api/system/health/route.ts`
- `src/app/api/user/list/route.ts`
- `src/app/api/webhooks/bolna/route.ts`

### Pages (App Router) (4)

- `src/app/(auth)/login/actions.ts`
- `src/app/(auth)/logout/actions.ts`
- `src/app/(dashboard)/deals/%5Bid%5D/page.tsx`
- `src/app/(dashboard)/disputes/page.tsx`

### Library / services (10)

- `src/lib/auth-utils.ts`
- `src/lib/auth/requireAdmin.ts`
- `src/lib/auth/requireSalesHead.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-full-dashboard.ts`
- `src/lib/db/seed-users.ts`
- `src/lib/kyc/admin-workflow.ts`
- `src/lib/nbfc/tenant.ts`
- `src/lib/supabase/identity.ts`
