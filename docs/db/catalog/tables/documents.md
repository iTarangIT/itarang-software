# `documents`

Drizzle export: `documents`
Sandbox row count: `0`
Primary surface: `/api/dealer/leads`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `lead_id` | `varchar` | yes | — |
| `document_type` | `varchar` | no | — |
| `file_url` | `text` | no | — |
| `uploaded_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `documents_lead_id_dealer_leads_id_fk` | `lead_id` | `dealer_leads`(`id`) | cascade |

## Referenced by

### API routes (34)

- `src/app/api/admin/dealer-verifications/[dealerId]/audit-trail/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/download-signed-agreement/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/fetch-audit-trail/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/refresh-agreement/route.ts`
- `src/app/api/admin/dealer-verifications/[dealerId]/route.ts`
- `src/app/api/admin/dealer-verifications/route.ts`
- `src/app/api/admin/kyc-reviews/route.ts`
- `src/app/api/admin/kyc/[leadId]/case-review/route.ts`
- `src/app/api/admin/kyc/[leadId]/coborrower-doc/[docId]/review/route.ts`
- `src/app/api/admin/lead/[id]/download-profile/route.ts`
- `src/app/api/coborrower/[leadId]/upload-document/route.ts`
- `src/app/api/coborrower/[leadId]/upload-other-document/route.ts`
- `src/app/api/cron/cleanup-leads/route.ts`
- `src/app/api/dealer-onboarding/save/route.ts`
- `src/app/api/dealer/leads/route.ts`
- `src/app/api/dealer/onboarding/submit/route.ts`
- `src/app/api/dealer/upload/route.ts`
- `src/app/api/debug/storage/route.ts`
- `src/app/api/documents/signed-url/route.ts`
- `src/app/api/documents/upload/route.ts`
- `src/app/api/kyc/[leadId]/complete-and-next/route.ts`
- `src/app/api/kyc/[leadId]/complete-step2/route.ts`
- `src/app/api/kyc/[leadId]/complete-step3/route.ts`
- `src/app/api/kyc/[leadId]/documents/route.ts`
- `src/app/api/kyc/[leadId]/re-upload/route.ts`
- `src/app/api/kyc/[leadId]/requested-docs/route.ts`
- `src/app/api/kyc/[leadId]/send-consent/route.ts`
- `src/app/api/kyc/[leadId]/submit-for-verification/route.ts`
- `src/app/api/kyc/[leadId]/upload-document/route.ts`
- `src/app/api/kyc/[leadId]/upload-signed-consent/route.ts`
- `src/app/api/kyc/digilocker/callback/[transactionId]/route.ts`
- `src/app/api/leads/autofillRequest/route.ts`
- `src/app/api/public/upload-docs/[leadId]/[requestId]/[token]/route.ts`
- `src/app/api/uploads/dealer-documents/route.ts`

### Pages (App Router) (15)

- `src/app/(dashboard)/admin/dealer-verification/[dealerId]/page.tsx`
- `src/app/(dashboard)/admin/dealer-verification/page.tsx`
- `src/app/(dashboard)/admin/kyc-review/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/borrower-consent/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/kyc/interim/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/kyc/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/drafts/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/new/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/page.tsx`
- `src/app/(dashboard)/dealer-portal/loans/facilitation/[id]/page.tsx`
- `src/app/(dashboard)/dealer-portal/loans/facilitation/page.tsx`
- `src/app/(dashboard)/dealer-portal/loans/page.tsx`
- `src/app/(dashboard)/dealer-portal/onboarding-status/page.tsx`
- `src/app/(dashboard)/sales-manager/leads/[id]/review/page.tsx`
- `src/app/(dashboard)/service-engineer/pdi/[id]/pdi-form.tsx`

### Library / services (8)

- `src/lib/agreement/dealer-agreement-template.ts`
- `src/lib/db/schema.ts`
- `src/lib/digio/ensure-audit-trail.ts`
- `src/lib/digio/ensure-signed-agreement.ts`
- `src/lib/digio/fetch-signed-consent.ts`
- `src/lib/email/sendDealerWelcomeEmail.ts`
- `src/lib/notifications.ts`
- `src/lib/storage.ts`
