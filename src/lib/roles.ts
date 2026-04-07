const ROLE_PATH_PREFIXES: Array<[string, string]> = [
  ["/sales-order-manager", "sales_order_manager"],
  ["/finance-controller", "finance_controller"],
  ["/inventory-manager", "inventory_manager"],
  ["/service-engineer", "service_engineer"],
  ["/dealer-portal", "dealer"],
  ["/business-head", "business_head"],
  ["/sales-manager", "sales_manager"],
  ["/sales-executive", "sales_executive"],
  ["/sales-head", "sales_head"],
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
