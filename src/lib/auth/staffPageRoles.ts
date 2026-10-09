/**
 * Who may open the procurement and deal pages that sit outside every role
 * dashboard: /orders, /provisions, /deals.
 *
 * These paths are "protected" in middleware — a signed-out visitor is sent to
 * /login — but none is a roleDashboards prefix, so the wrong-role bounce never
 * ran for them and they rendered for ANY signed-in role, a dealer or an NBFC
 * partner included. The pages then read every row straight from the database.
 *
 * Kept dependency-free (no imports) on purpose, like src/lib/buyback/roles.ts:
 * `src/middleware.ts` runs on the Edge runtime and imports this to bounce the
 * wrong role, and the pages import the same lists for their own requireRole —
 * the page check is what still holds if a request skips middleware.
 *
 * Each list is the roles the matching API already admits to read
 * (GET /api/orders, /api/provisions, /api/deals), plus the roles whose own
 * dashboard or sidebar links here.
 */
export const ORDERS_PAGE_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "finance_controller",
  "inventory_manager",
  // /sales-order-manager/orders and /pi-invoices link to /orders/<id>.
  "sales_order_manager",
] as const;

export const PROVISIONS_PAGE_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "finance_controller",
  "inventory_manager",
  // /sales-order-manager/provisions links to /provisions/new and create-order.
  "sales_order_manager",
] as const;

export const DEALS_PAGE_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  // "My Deals" in the sales_executive sidebar.
  "sales_executive",
  "finance_controller",
] as const;

/**
 * ID 91 — the shared Reports page (Analyses, Data downloads, Scheduled email
 * reports) for everyone the redesign board's REPORTS menu is for. The APIs
 * behind each tab re-check their own roles.
 */
export const REPORTS_PAGE_ROLES = ["admin", "ceo", "sales_head"] as const;

/** Prefix → roles, for middleware. Matched on a whole path segment. */
export const STAFF_PAGE_ROLES: Record<string, readonly string[]> = {
  "/reports": REPORTS_PAGE_ROLES,
  "/orders": ORDERS_PAGE_ROLES,
  "/provisions": PROVISIONS_PAGE_ROLES,
  "/deals": DEALS_PAGE_ROLES,
};

/**
 * The roles allowed on this path, or undefined when it is not one of these
 * pages. Segment equality, not startsWith: "/deals" must not claim
 * "/dealer-portal", nor "/orders" a future "/orders-archive".
 */
export function staffPageRolesFor(path: string): readonly string[] | undefined {
  for (const [prefix, roles] of Object.entries(STAFF_PAGE_ROLES)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return roles;
  }
  return undefined;
}
