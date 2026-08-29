/**
 * The admin Notification Access screen (E-231) is only as complete as this
 * registry. A notification type with no label still renders — falling back to
 * its raw string — so a gap here is invisible in the browser and shows up only
 * as a confusing `snake_case` row nobody can interpret.
 *
 * These assertions are the loud version of that. They run in `npm test`.
 */

import { describe, expect, it } from "vitest";

import { CATEGORY_BY_TYPE } from "@/lib/notifications/catalog";
import { CATEGORY_BY_ACTION } from "@/lib/buyback/notification-meta";
import {
  DASHBOARDS,
  TYPE_LABELS,
  allGovernableTypes,
  assertRegistryComplete,
  editableDashboardsFor,
  isKnownDashboard,
  isKnownType,
  typeGroups,
} from "@/lib/notifications/registry";

// The 17 roles from src/middleware.ts `roleDashboards`. Hardcoded on purpose:
// importing middleware.ts here would drag Next's request machinery into a pure
// unit test, and — more importantly — a copy that must be edited deliberately is
// exactly the point. If someone adds an 18th role, this test fails and they have
// to decide whether it belongs on the screen.
const ROLES_IN_MIDDLEWARE = [
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
  "sales_insight",
  "inside_sales_rep",
  "asm",
  "finance_controller",
  "inventory_manager",
  "service_engineer",
  "sales_order_manager",
  "dealer",
  "admin",
  "it",
  "nbfc_partner",
  "scrap_vendor",
];

describe("notification registry", () => {
  it("labels every governable notification type", () => {
    // Named individually so the failure tells you what to write, not just a count.
    const missing = allGovernableTypes().filter((t) => !TYPE_LABELS[t]);
    expect(missing, `unlabelled notification types: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no label for a type that no longer exists", () => {
    const known = new Set(allGovernableTypes());
    const orphans = Object.keys(TYPE_LABELS).filter((t) => !known.has(t));
    expect(orphans, `labels for types not in the catalogue: ${orphans.join(", ")}`).toEqual([]);
  });

  it("keeps every type within notifications.type's varchar(50)", () => {
    // emit.ts safeType() truncates silently past 50, which would make the stored
    // row both mis-categorised and unmatchable against the notification_access
    // row this screen wrote.
    const tooLong = allGovernableTypes().filter((t) => t.length > 50);
    expect(tooLong).toEqual([]);
  });

  it("derives its type list from the two taxonomies", () => {
    expect(allGovernableTypes()).toHaveLength(
      Object.keys(CATEGORY_BY_TYPE).length + Object.keys(CATEGORY_BY_ACTION).length,
    );
  });

  it("lists exactly the roles middleware knows about", () => {
    expect([...DASHBOARDS.map((d) => d.value)].sort()).toEqual([...ROLES_IN_MIDDLEWARE].sort());
  });

  it("only uses lowercase dashboard values", () => {
    // E-231 has a CHECK (dashboard = lower(dashboard)); a mixed-case value here
    // would fail the insert, and worse, would never match LOWER(users.role).
    expect(DASHBOARDS.filter((d) => d.value !== d.value.toLowerCase())).toEqual([]);
  });

  it("groups every type into exactly one category", () => {
    const grouped = typeGroups().flatMap((g) => g.types.map((t) => t.value));
    expect(grouped.sort()).toEqual([...allGovernableTypes()].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("passes its own completeness guard", () => {
    expect(() => assertRegistryComplete()).not.toThrow();
  });

  describe("scope", () => {
    it("gives admin and ceo every dashboard", () => {
      expect(editableDashboardsFor("admin")).toHaveLength(DASHBOARDS.length);
      expect(editableDashboardsFor("ceo")).toHaveLength(DASHBOARDS.length);
    });

    it("gives sales_head its reporting line plus CEO, Dealer and NBFC", () => {
      const scope = editableDashboardsFor("sales_head");
      expect(scope).toContain("sales_head");
      expect(scope).toContain("asm");
      // Granted on request despite the supervisor/contractual concerns noted on
      // SALES_HEAD_SCOPE — asserted so re-tightening is a deliberate edit.
      expect(scope).toContain("ceo");
      expect(scope).toContain("dealer");
      expect(scope).toContain("nbfc_partner");
      // Still out of scope.
      expect(scope).not.toContain("admin");
      expect(scope).not.toContain("it");
      expect(scope).not.toContain("scrap_vendor");
    });

    it("gives everyone else nothing", () => {
      for (const role of ["dealer", "asm", "it", "nbfc_partner", "", null, undefined]) {
        expect(editableDashboardsFor(role as string)).toEqual([]);
      }
    });

    it("is case-insensitive about the caller's role", () => {
      // Seeded users.role values are inconsistently cased — see emit.ts.
      expect(editableDashboardsFor("Sales_Head")).toEqual(editableDashboardsFor("sales_head"));
      expect(editableDashboardsFor(" ADMIN ")).toHaveLength(DASHBOARDS.length);
    });
  });

  describe("validators the API relies on", () => {
    it("recognises both naming generations", () => {
      expect(isKnownType("lead.assigned")).toBe(true);
      expect(isKnownType("kyc_rejected")).toBe(true);
      expect(isKnownType("buyback.submit")).toBe(true);
      expect(isKnownType("nope.not_a_type")).toBe(false);
      expect(isKnownType("buyback.not_an_action")).toBe(false);
    });

    it("recognises dashboards case-insensitively", () => {
      expect(isKnownDashboard("dealer")).toBe(true);
      expect(isKnownDashboard("DEALER")).toBe(true);
      expect(isKnownDashboard("driver")).toBe(false);
    });
  });
});
