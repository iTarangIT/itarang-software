/**
 * Path prefix → role, for inferring a role from where someone already is.
 *
 * MUST be kept in step with middleware.ts's `roleDashboards`. It is not: asm,
 * inside_sales_rep, sales_insight and nbfc_partner all have dashboards there
 * and no entry here, which is what a role registry scattered across six
 * hardcoded lists gets you. A missing row fails silently — resolveRole() just
 * returns the fallback — so nothing ever complained.
 *
 * Longest-prefix-first is load-bearing: "/admin" must stay last or it would
 * swallow "/admin/buyback"-style paths belonging to a more specific entry.
 */
const ROLE_PATH_PREFIXES: Array<[string, string]> = [
  ["/sales-order-manager", "sales_order_manager"],
  ["/finance-controller", "finance_controller"],
  ["/inventory-manager", "inventory_manager"],
  ["/service-engineer", "service_engineer"],
  ["/inside-sales", "inside_sales_rep"],
  ["/sales-insight", "sales_insight"],
  ["/vendor-portal", "scrap_vendor"],
  ["/dealer-portal", "dealer"],
  ["/business-head", "business_head"],
  ["/sales-manager", "sales_manager"],
  ["/sales-executive", "sales_executive"],
  ["/sales-head", "sales_head"],
  ["/nbfc", "nbfc_partner"],
  ["/asm", "asm"],
  ["/ceo", "ceo"],
  ["/admin", "admin"],
];

export function normalizeRole(role?: string | null) {
  const value = (role || "").trim().toLowerCase();

  if (!value) {
    return "user";
  }

  return value.replace(/[.\s-]+/g, "_");
}

export function inferRoleFromPath(pathname?: string | null) {
  if (!pathname) {
    return null;
  }

  const matchedPrefix = ROLE_PATH_PREFIXES.find(([prefix]) => {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });

  return matchedPrefix?.[1] ?? null;
}

export function resolveRole(role?: string | null, pathname?: string | null) {
  const normalizedRole = normalizeRole(role);

  if (normalizedRole !== "user") {
    return normalizedRole;
  }

  return inferRoleFromPath(pathname) ?? normalizedRole;
}

export function formatRoleLabel(role?: string | null, pathname?: string | null) {
  return resolveRole(role, pathname).replace(/_/g, " ");
}
