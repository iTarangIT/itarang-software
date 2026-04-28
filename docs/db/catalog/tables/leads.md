# `leads`

Drizzle export: `leads`
Sandbox row count: `183`
Primary surface: `/api/calls`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `owner_name` | `text` | yes | — |
| `owner_contact` | `varchar` | yes | — |
| `full_name` | `text` | yes | — |
| `phone` | `varchar` | yes | — |
| `mobile` | `varchar` | yes | — |
| `business_name` | `text` | yes | — |
| `owner_email` | `text` | yes | — |
| `state` | `varchar` | yes | — |
| `city` | `varchar` | yes | — |
| `shop_address` | `text` | yes | — |
| `local_address` | `text` | yes | — |
| `permanent_address` | `text` | yes | — |
| `current_address` | `text` | yes | — |
| `vehicle_rc` | `varchar` | yes | — |
| `dob` | `timestamptz` | yes | — |
| `father_or_husband_name` | `text` | yes | — |
| `status` | `varchar` | yes | — |
| `kyc_status` | `varchar` | yes | — |
| `payment_method` | `varchar` | yes | — |
| `consent_status` | `varchar` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `lead_source` | `varchar` | yes | — |
| `lead_type` | `varchar` | yes | — |
| `lead_status` | `varchar` | yes | — |
| `lead_score` | `int4` | yes | — |
| `interest_level` | `varchar` | yes | — |
| `reference_id` | `varchar` | yes | — |
| `uploader_id` | `uuid` | yes | — |
| `vehicle_ownership` | `varchar` | yes | — |
| `vehicle_owner_name` | `text` | yes | — |
| `vehicle_owner_phone` | `varchar` | yes | — |
| `battery_type` | `varchar` | yes | — |
| `asset_model` | `text` | yes | — |
| `asset_price` | `numeric` | yes | — |
| `family_members` | `int4` | yes | — |
| `driving_experience` | `int4` | yes | — |
| `is_current_same` | `bool` | yes | yes |
| `product_category_id` | `varchar` | yes | — |
| `product_type_id` | `varchar` | yes | — |
| `primary_product_id` | `uuid` | yes | — |
| `interested_in` | `jsonb` | yes | — |
| `battery_order_expected` | `int4` | yes | — |
| `investment_capacity` | `numeric` | yes | — |
| `business_type` | `varchar` | yes | — |
| `qualified_by` | `uuid` | yes | — |
| `qualified_at` | `timestamptz` | yes | — |
| `qualification_notes` | `text` | yes | — |
| `converted_deal_id` | `varchar` | yes | — |
| `converted_at` | `timestamptz` | yes | — |
| `total_ai_calls` | `int4` | yes | yes |
| `last_ai_call_at` | `timestamptz` | yes | — |
| `last_call_outcome` | `text` | yes | — |
| `last_call_status` | `text` | yes | — |
| `conversation_summary` | `text` | yes | — |
| `ai_priority_score` | `numeric` | yes | — |
| `next_call_after` | `timestamptz` | yes | — |
| `next_call_at` | `timestamptz` | yes | — |
| `do_not_call` | `bool` | yes | yes |
| `ai_managed` | `bool` | yes | yes |
| `ai_owner` | `text` | yes | — |
| `manual_takeover` | `bool` | yes | yes |
| `last_ai_action_at` | `timestamptz` | yes | — |
| `intent_score` | `int4` | yes | — |
| `intent_reason` | `text` | yes | — |
| `call_priority` | `int4` | yes | yes |
| `workflow_step` | `int4` | yes | yes |
| `auto_filled` | `bool` | yes | yes |
| `ocr_status` | `varchar` | yes | — |
| `ocr_error` | `text` | yes | — |
| `coupon_code` | `varchar` | yes | — |
| `coupon_status` | `varchar` | yes | — |
| `kyc_score` | `int4` | yes | — |
| `kyc_completed_at` | `timestamptz` | yes | — |
| `has_co_borrower` | `bool` | yes | yes |
| `has_additional_docs_required` | `bool` | yes | yes |
| `interim_step_status` | `varchar` | yes | — |
| `kyc_draft_data` | `jsonb` | yes | — |
| `sm_review_status` | `varchar` | yes | — |
| `submitted_to_sm_at` | `timestamptz` | yes | — |
| `sm_assigned_to` | `uuid` | yes | — |
| `sold_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Referenced by

### API routes (110)

- `src/app/api/admin/coupons/[couponId]/release/route.ts`
- `src/app/api/admin/coupons/[couponId]/revoke/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/approve/route.ts`
- `src/app/api/admin/kyc-reviews/route.ts`
- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts`
- `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/status/[transactionId]/route.ts`
- `src/app/api/admin/kyc/[leadId]/cancel-verification/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/report/route.ts`
- `src/app/api/admin/kyc/[leadId]/cibil/score/route.ts`
- `src/app/api/admin/kyc/[leadId]/final-decision/route.ts`
- `src/app/api/admin/kyc/[leadId]/step3/request-coborrower/route.ts`
- `src/app/api/admin/kyc/[leadId]/step3/request-docs/route.ts`
- `src/app/api/admin/kyc/[leadId]/verification/[verificationId]/action/route.ts`
- `src/app/api/admin/kyc/queue/route.ts`
- `src/app/api/admin/lead/[id]/download-profile/route.ts`
- `src/app/api/admin/lead/[id]/product-selection/route.ts`
- `src/app/api/admin/lead/[id]/reject-loan/route.ts`
- `src/app/api/admin/lead/[id]/sanction-loan/route.ts`
- `src/app/api/ai-dialer/route.ts`
- `src/app/api/ai-dialer/run/route.ts`
- `src/app/api/ai/rank-leads/route.ts`
- `src/app/api/approvals/[id]/approve/route.ts`
- `src/app/api/bolna/call-scheduler/route.ts`
- `src/app/api/calls/route.ts`
- `src/app/api/calls/session/start/route.ts`
- `src/app/api/campaigns/estimate-audience/route.ts`
- `src/app/api/ceo/ai-dialer/assign/route.ts`
- `src/app/api/ceo/ai-dialer/call/route.ts`
- `src/app/api/ceo/ai-dialer/queue/route.ts`
- `src/app/api/ceo/ai-dialer/takeover/route.ts`
- `src/app/api/ceo/ai-dialer/webhook/bolna/route.ts`
- `src/app/api/coborrower/[leadId]/access-check/route.ts`
- `src/app/api/coborrower/[leadId]/complete-and-preview/route.ts`
- `src/app/api/coborrower/[leadId]/save-draft/route.ts`
- `src/app/api/cron/ai-dialer/route.ts`
- `src/app/api/cron/call/route.ts`
- `src/app/api/cron/cleanup-leads/route.ts`
- `src/app/api/dealer-leads/route.ts`
- `src/app/api/dealer/leads/[id]/route.ts`
- `src/app/api/dealer/leads/drafts/[leadId]/route.ts`
- `src/app/api/dealer/leads/drafts/route.ts`
- `src/app/api/dealer/leads/route.ts`
- `src/app/api/dealer/loan-facilitation/[id]/pay-fee/route.ts`
- `src/app/api/dealer/loan-facilitation/[id]/route.ts`
- `src/app/api/dealer/loan-facilitation/queue/route.ts`
- `src/app/api/dealer/loan-facilitation/stats/route.ts`
- `src/app/api/dealer/stats/route.ts`
- `src/app/api/deals/[id]/route.ts`
- `src/app/api/deals/route.ts`
- `src/app/api/help/lead-step-1/route.ts`
- `src/app/api/kyc/[leadId]/access-check/route.ts`
- `src/app/api/kyc/[leadId]/borrower-details/route.ts`
- `src/app/api/kyc/[leadId]/complete-and-next/route.ts`
- `src/app/api/kyc/[leadId]/complete-step2/route.ts`
- `src/app/api/kyc/[leadId]/complete-step3/route.ts`
- `src/app/api/kyc/[leadId]/consent/admin/route.ts`
- `src/app/api/kyc/[leadId]/consent/sync/route.ts`
- `src/app/api/kyc/[leadId]/create-payment-qr/route.ts`
- `src/app/api/kyc/[leadId]/document-status/route.ts`
- `src/app/api/kyc/[leadId]/facilitation-payment/route.ts`
- `src/app/api/kyc/[leadId]/generate-consent-pdf/route.ts`
- `src/app/api/kyc/[leadId]/payment-method/route.ts`
- `src/app/api/kyc/[leadId]/regenerate-payment-qr/route.ts`
- `src/app/api/kyc/[leadId]/release-coupon/route.ts`
- `src/app/api/kyc/[leadId]/save-draft/route.ts`
- `src/app/api/kyc/[leadId]/send-consent/route.ts`
- `src/app/api/kyc/[leadId]/submit-verification/route.ts`
- `src/app/api/kyc/[leadId]/upload-signed-consent/route.ts`
- `src/app/api/kyc/[leadId]/validate-coupon/route.ts`
- `src/app/api/lead/[id]/confirm-cash-sale/route.ts`
- `src/app/api/lead/[id]/step-4-access/route.ts`
- `src/app/api/lead/[id]/step-5/confirm-dispatch/route.ts`
- `src/app/api/lead/[id]/step-5/send-otp/route.ts`
- `src/app/api/lead/[id]/step-5/status/route.ts`
- `src/app/api/lead/[id]/submit-product-selection/route.ts`
- `src/app/api/leads/[id]/assign/route.ts`
- `src/app/api/leads/[id]/discard/route.ts`
- `src/app/api/leads/[id]/loan-offers/[offerId]/book/route.ts`
- `src/app/api/leads/[id]/loan-offers/[offerId]/select/route.ts`
- `src/app/api/leads/[id]/loan-offers/route.ts`
- `src/app/api/leads/[id]/qualify/route.ts`
- `src/app/api/leads/[id]/route.ts`
- `src/app/api/leads/[id]/submit-to-sm/route.ts`
- `src/app/api/leads/check-duplicate/route.ts`
- `src/app/api/leads/create/route.ts`
- `src/app/api/leads/digilocker/callback/[transactionId]/route.ts`
- `src/app/api/leads/digilocker/initiate/route.ts`
- `src/app/api/leads/draft/[sessionId]/route.ts`
- `src/app/api/leads/import/route.ts`
- `src/app/api/leads/in-progress/route.ts`
- `src/app/api/leads/route.ts`
- `src/app/api/scraper-leads/[id]/page.tsx`
- `src/app/api/scraper-leads/[id]/promote/route.ts`
- `src/app/api/scraper-leads/[id]/push-to-lead/route.ts`
- `src/app/api/scraper-leads/converted/download/route.ts`
- `src/app/api/scraper-leads/converted/route.ts`
- `src/app/api/scraper-leads/route.ts`
- `src/app/api/scraper/leads/[id]/assign/route.ts`
- `src/app/api/scraper/leads/[id]/status/route.ts`
- `src/app/api/scraper/leads/route.ts`
- `src/app/api/scraper/runs/[id]/route.ts`
- `src/app/api/search/global/route.ts`
- `src/app/api/sm/leads/[id]/loan-offers/route.ts`
- `src/app/api/sm/leads/[id]/mark-verified/route.ts`
- `src/app/api/sm/leads/[id]/request-doc/route.ts`
- `src/app/api/sm/leads/[id]/submit-options/route.ts`
- `src/app/api/sm/leads/route.ts`
- `src/app/api/webhooks/bolna/route.ts`
- `src/app/api/webhooks/digio/route.ts`

### Pages (App Router) (30)

- `src/app/(dashboard)/admin/kyc-review/page.tsx`
- `src/app/(dashboard)/business-head/credits/page.tsx`
- `src/app/(dashboard)/business-head/page.tsx`
- `src/app/(dashboard)/ceo/ai-dialer/page.tsx`
- `src/app/(dashboard)/ceo/page.tsx`
- `src/app/(dashboard)/dealer-portal/campaigns/new/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/borrower-consent/error.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/borrower-consent/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/kyc/error.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/kyc/interim/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/kyc/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/options/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/product-selection/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/step-5/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/drafts/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/new/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/page.tsx`
- `src/app/(dashboard)/deals/%5Bid%5D/page.tsx`
- `src/app/(dashboard)/deals/page.tsx`
- `src/app/(dashboard)/finance-controller/credits/page.tsx`
- `src/app/(dashboard)/finance-controller/invoices/page.tsx`
- `src/app/(dashboard)/leads/[id]/edit/page.tsx`
- `src/app/(dashboard)/leads/[id]/page.tsx`
- `src/app/(dashboard)/leads/import/route.ts`
- `src/app/(dashboard)/leads/new/page.tsx`
- `src/app/(dashboard)/leads/page.tsx`
- `src/app/(dashboard)/sales-manager/ai-calls/page.tsx`
- `src/app/(dashboard)/sales-manager/leads/[id]/options/page.tsx`
- `src/app/(dashboard)/sales-manager/leads/[id]/review/page.tsx`
- `src/app/(dashboard)/sales-manager/page.tsx`

### Library / services (25)

- `src/lib/agreement/dealer-agreement-template.ts`
- `src/lib/ai-call-service.ts`
- `src/lib/ai/bolna_ai/webhookHandler.ts`
- `src/lib/ai/langgraph/lead-qualification-graph.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-full-dashboard.ts`
- `src/lib/dealer-scraper-service.ts`
- `src/lib/decentro.ts`
- `src/lib/digio/sync-consent-status.ts`
- `src/lib/kyc/pan-verification.ts`
- `src/lib/notifications.ts`
- `src/lib/public-origin.ts`
- `src/lib/sales/sale-finalization.ts`
- `src/lib/scraper/chunkedPipeline.ts`
- `src/lib/scraper/city-expander.ts`
- `src/lib/scraper/pipeline.ts`
- `src/lib/scraper/processing/dedupe.ts`
- `src/lib/scraper/processing/filter.ts`
- `src/lib/scraper/processing/normalize.ts`
- `src/lib/scraper/query/sources/firecrawl.ts`
- `src/lib/scraper/query/sources/index.ts`
- `src/lib/scraper/storage/duplicateStore.ts`
- `src/lib/scraper/storage/leadStore.ts`
- `src/lib/scraper/storage/rawStore.ts`
