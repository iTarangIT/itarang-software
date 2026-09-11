/**
 * auditRoleOf — the one place the CRM role leaks into buyback_activity_log.
 *
 * The state machine only knows dealer | admin | vendor. The `partner` login is
 * the single staff role attributed as itself on the audit trail; every other
 * staff role keeps logging "admin" so existing rows and readers are untouched.
 * This pins both halves: partner is written through, sales_head is not.
 */
import { describe, expect, it } from "vitest";
import { auditRoleOf } from "../transition";

describe("auditRoleOf", () => {
  it("passes the machine role through when no CRM role is attached", () => {
    expect(auditRoleOf({ role: "admin" })).toBe("admin");
    expect(auditRoleOf({ role: "dealer" })).toBe("dealer");
    expect(auditRoleOf({ role: "vendor" })).toBe("vendor");
  });

  it("tags the partner login as partner", () => {
    expect(auditRoleOf({ role: "admin", crmRole: "partner" })).toBe("partner");
  });

  it("keeps every other staff role as admin", () => {
    for (const crmRole of ["admin", "ceo", "business_head", "sales_head", ""]) {
      expect(auditRoleOf({ role: "admin", crmRole })).toBe("admin");
    }
  });
});
