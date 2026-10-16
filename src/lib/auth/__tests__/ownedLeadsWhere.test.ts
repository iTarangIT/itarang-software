import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { kycLeadScope } from "@/lib/auth/leadAccessRules";
import { ownedLeadsWhere } from "@/lib/auth/ownedLeadsWhere";

const dialect = new PgDialect();
const render = (q: ReturnType<typeof ownedLeadsWhere>) => (q ? dialect.sqlToQuery(q) : null);
const col = sql.raw("q.lead_id");

describe("kycLeadScope (ID 119)", () => {
  it("lets Admin, CEO and Sales Head see every customer file", () => {
    for (const role of ["admin", "ceo", "sales_head", "ADMIN"]) expect(kycLeadScope(role)).toBe("all");
  });

  it("limits Business Head, Sales Manager, Sales Executive and Finance to their own", () => {
    for (const role of ["business_head", "sales_manager", "sales_executive", "finance_controller"]) {
      expect(kycLeadScope(role)).toBe("own");
    }
  });

  it("gives every other role nothing", () => {
    for (const role of ["dealer", "user", "", null, undefined, "nbfc_partner"]) expect(kycLeadScope(role)).toBe("none");
  });
});

describe("ownedLeadsWhere (ID 119)", () => {
  it("adds no filter for the all-leads roles", () => {
    expect(ownedLeadsWhere({ id: "u-1", role: "ceo" }, col)).toBeUndefined();
  });

  it("filters an own-leads role on the four owner columns, bound to its id", () => {
    const q = render(ownedLeadsWhere({ id: "u-1", role: "sales_manager" }, col));
    expect(q?.sql).toContain("q.lead_id IN (");
    for (const c of ["uploader_id", "assigned_to", "sm_assigned_to", "owner_user_id"]) expect(q?.sql).toContain(c);
    expect(q?.params).toEqual(["u-1", "u-1", "u-1", "u-1"]);
  });

  it("refuses everything for other roles and for a missing id", () => {
    expect(render(ownedLeadsWhere({ id: "u-1", role: "dealer" }, col))?.sql).toBe("FALSE");
    expect(render(ownedLeadsWhere({ id: "  ", role: "sales_manager" }, col))?.sql).toBe("FALSE");
  });
});
