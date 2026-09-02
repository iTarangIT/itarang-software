/**
 * Path → role inference, and the registry drift it exists to catch.
 *
 * `users.role` is a bare varchar(50) with no enum and no CHECK, so a role is
 * whatever nine independent hardcoded lists agree it is:
 *
 *   1. middleware.ts       roleDashboards   (role → dashboard; also the protected-route registry)
 *   2. sidebar.tsx         roleNavigation   (the nav itself)
 *   3. sidebar.tsx         inferredRole     (path → role, so the nav paints before auth resolves)
 *   4. login/page.tsx      the redirect if/else
 *   5. login/actions.ts    a second redirect if/else
 *   6. lib/roles.ts        ROLE_PATH_PREFIXES (this file)
 *   7. sidebar.tsx         NO_COMMON_ITEMS  (opt out of the shared "Submit Expense" item)
 *   8. sidebar.tsx         showMobileDrawer (whether the role gets the mobile drawer)
 *   9. header.tsx          showMobileNav    (an independent copy of 8 — keep in step)
 *
 * (This header said "six" until the `operations` role was added and 7-9 were
 * found to matter too. 1-6 are the ones that break login; 7-9 break chrome.)
 *
 * Missing one fails SILENTLY — an unknown role falls back to the `user` nav or
 * a `/` redirect, with no error anywhere. That is not hypothetical: asm,
 * inside_sales_rep, sales_insight and nbfc_partner had dashboards in
 * middleware for months with no entry here, and nothing ever complained.
 *
 * This file can only police list 6. It is here so the next person adding a role
 * finds the other eight written down.
 */

import { describe, expect, it } from "vitest";

import { formatRoleLabel, inferRoleFromPath, normalizeRole, resolveRole } from "../roles";

describe("inferRoleFromPath", () => {
  it.each([
    ["/vendor-portal", "scrap_vendor"],
    ["/vendor-portal/quotations", "scrap_vendor"],
    ["/dealer-portal", "dealer"],
    ["/dealer-portal/buyback/new", "dealer"],
    ["/admin", "admin"],
    ["/admin/buyback/dashboard", "admin"],
    ["/asm", "asm"],
    ["/nbfc", "nbfc_partner"],
    ["/inside-sales", "inside_sales_rep"],
    ["/sales-insight", "sales_insight"],
    ["/sales-head", "sales_head"],
    ["/sales-order-manager", "sales_order_manager"],
    ["/operations", "operations"],
    ["/operations/infrastructure", "operations"],
  ])("%s → %s", (path, role) => {
    expect(inferRoleFromPath(path)).toBe(role);
  });

  it("does not match a prefix that merely starts the same way", () => {
    // "/vendor-portal-admin" is not the vendor portal. Guards the
    // `pathname === prefix || startsWith(prefix + "/")` rule.
    expect(inferRoleFromPath("/vendor-portal-admin")).toBeNull();
    expect(inferRoleFromPath("/dealer-portalX")).toBeNull();
  });

  it("returns null for an unknown path rather than guessing", () => {
    expect(inferRoleFromPath("/leads")).toBeNull();
    expect(inferRoleFromPath(null)).toBeNull();
  });

  it("keeps the vendor portal distinct from the dealer portal", () => {
    // Both are "-portal" and both are counterparties, but a vendor must never
    // resolve to `dealer` — that role's nav and scoping are a different world.
    expect(inferRoleFromPath("/vendor-portal")).not.toBe("dealer");
  });
});

describe("normalizeRole", () => {
  it("canonicalises separators and case", () => {
    expect(normalizeRole("Scrap Vendor")).toBe("scrap_vendor");
    expect(normalizeRole("scrap-vendor")).toBe("scrap_vendor");
    expect(normalizeRole("SCRAP_VENDOR")).toBe("scrap_vendor");
  });

  it("falls back to user for blank input", () => {
    expect(normalizeRole("")).toBe("user");
    expect(normalizeRole(null)).toBe("user");
    expect(normalizeRole("   ")).toBe("user");
  });
});

describe("resolveRole prefers the stated role over the path", () => {
  it("trusts the role when there is one", () => {
    // An admin looking at a vendor's portal is still an admin.
    expect(resolveRole("admin", "/vendor-portal")).toBe("admin");
  });

  it("falls back to the path only when the role is absent", () => {
    expect(resolveRole(null, "/vendor-portal")).toBe("scrap_vendor");
    expect(resolveRole("", "/vendor-portal/quotations")).toBe("scrap_vendor");
  });

  it("gives up to `user` when neither says anything", () => {
    expect(resolveRole(null, "/leads")).toBe("user");
  });
});

describe("formatRoleLabel", () => {
  it("renders a role for humans", () => {
    expect(formatRoleLabel("scrap_vendor")).toBe("scrap vendor");
    expect(formatRoleLabel(null, "/vendor-portal")).toBe("scrap vendor");
  });
});
