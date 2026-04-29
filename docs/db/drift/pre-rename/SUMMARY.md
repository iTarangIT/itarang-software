# Drizzle TS-field rename — type-check before/after summary

## Pre-rename (baseline)

Total errors: 2370

Distribution by code:
```
   1877 TS2551
    214 TS2561
    181 TS2769
     71 TS2339
      8 TS2345
      3 TS2693
      3 TS2322
      3 TS2307
      2 TS2559
      2 TS2538
```

## Post-rename

Total errors: 83

Distribution by code:
```
     26 TS2769
     17 TS2339
     13 TS2345
     10 TS2322
      5 TS18047
      3 TS2693
      3 TS2307
      2 TS2538
      2 TS2353
      1 TS2551
```

## Net change

Errors removed: 2287

Top files with surviving errors (post-rename):
```
      7 src/app/api/admin/kyc-reviews/route.ts
      4 src/lib/sales-utils.ts
      4 src/app/api/leads/autofillRequest/route.ts
      4 src/app/api/admin/kyc/[leadId]/case-review/route.ts
      3 src/app/api/dealer/leads/route.ts
      3 src/app/api/admin/dealer-verifications/[dealerId]/download-signed-agreement/route.ts
      3 src/app/(dashboard)/sales-order-manager/provisions/page.tsx
      3 src/app/(dashboard)/sales-manager/ai-calls/page.tsx
      3 drizzle/schema.ts
      2 src/lib/db/seed-full-dashboard.ts
      2 src/components/accounts/ReorderTracking.tsx
      2 src/app/api/dealer-onboarding/save/route.ts
      2 src/app/api/admin/dealer-verifications/[dealerId]/audit-trail/route.ts
      2 src/app/(dashboard)/provisions/page.tsx
      2 scripts/seed-prod-test-data.ts
```
