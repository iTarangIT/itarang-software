/**
 * The surface catalogue the scanner walks. Seeded starting at DEALER ONBOARDING
 * (the tool's primary entry point), then lead-KYC and admin-verification. These
 * are curated seeds; the LangGraph agent (Step 4) can discover more links/forms
 * per page and feed them back. Routes that don't exist on a target simply 404 —
 * probes only ever flag positives, so extra entries are harmless.
 */

/** Pages the scanner visits to enumerate links/forms. */
export const SEED_PAGES: string[] = [
  "/dealer-onboarding",
  "/vendor-onboarding",
  "/dealer-portal",
  "/dealer-portal/leads/new",
  "/login",
];

/** Endpoints that expose data and must NOT be readable unauthenticated. */
export interface UnauthTarget {
  path: string;
  pii?: boolean;
  note: string;
}
export const SENSITIVE_UNAUTH_ROUTES: UnauthTarget[] = [
  { path: "/api/dealer-onboarding/list", pii: true, note: "Every dealer onboarding application (GST/PAN/bank/owner contact)." },
  { path: "/api/leads/summary", note: "Lead summary data." },
  { path: "/api/leads/1/summary", note: "Per-lead summary." },
  { path: "/api/scraper-leads", pii: true, note: "Scraped lead contacts." },
  { path: "/api/scraper-leads/converted", pii: true, note: "Converted scraped leads." },
  { path: "/api/pdi/inventory", note: "PDI inventory listing." },
  { path: "/api/dealer-leads/regions/tree", note: "Region tree." },
];

/** Debug/introspection endpoints that should never be exposed. */
export const DEBUG_ROUTES: string[] = [
  "/api/debug/onboarding-db",
  "/api/debug/storage",
  "/api/debug/create-onboarding-tables",
  "/api/debug/alter-onboarding-table",
  "/api/test-aws",
  "/api/test-email",
  "/api/test-sheet",
];

/** Admin-only surfaces a dealer (or anon) must be redirected away from. */
export interface AdminSurface {
  path: string;
  kind: "page" | "api";
  note: string;
}
export const ADMIN_SURFACES: AdminSurface[] = [
  { path: "/admin", kind: "page", note: "Admin dashboard root." },
  { path: "/admin/dealer-verification", kind: "page", note: "Dealer verification queue." },
  { path: "/admin/kyc-review", kind: "page", note: "KYC review queue." },
  { path: "/ceo", kind: "page", note: "CEO dashboard." },
  { path: "/api/admin/nbfc/approvals/count", kind: "api", note: "Admin NBFC approvals count." },
  { path: "/api/admin/dealer-verifications/export", kind: "api", note: "Dealer verifications export." },
];

/** ID-scoped routes with weak/no ownership checks — the IDOR surface. */
export function idScopedRoutes(id: string): string[] {
  return [
    `/api/dealer-onboarding/${id}`,
    `/api/kyc/${id}/documents`,
    `/api/kyc/${id}/verifications`,
    `/api/kyc/${id}/payment-method`,
    `/api/coborrower/${id}`,
    `/api/coborrower/${id}/documents`,
    `/api/leads/${id}/summary`,
  ];
}

/** Pages/endpoints that reflect a query param back into the response. */
export interface ReflectTarget {
  path: string;
  param: string;
}
export const REFLECTED_PARAM_TARGETS: ReflectTarget[] = [
  { path: "/api/search", param: "q" },
  { path: "/dealer-portal/leads", param: "q" },
  { path: "/login", param: "redirect" },
];
