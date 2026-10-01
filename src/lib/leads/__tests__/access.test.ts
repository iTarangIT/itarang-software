import { describe, expect, it } from "vitest";
import { LEAD_HISTORY_EXPORT_ROLES, canExportLeadHistory, exportsOwnLeadsOnly } from "../access";

const ME = "user-1";
const OTHER = "user-2";

describe("lead exports — a rep takes away only the leads they own (ID 58)", () => {
    it("reps, ASMs and the partner login are own-leads-only; managers are not", () => {
        for (const r of ["asm", "inside_sales_rep", "partner", "ASM"]) expect(exportsOwnLeadsOnly(r), r).toBe(true);
        for (const r of ["admin", "ceo", "sales_head", "sales_manager", "business_head", "", null, undefined]) {
            expect(exportsOwnLeadsOnly(r), String(r)).toBe(false);
        }
    });

    it("history export: a rep needs to be the lead's current owner", () => {
        for (const role of ["inside_sales_rep", "asm", "partner"]) {
            expect(canExportLeadHistory({ role, userId: ME, currentOwnerId: ME }), role).toBe(true);
            expect(canExportLeadHistory({ role, userId: ME, currentOwnerId: OTHER }), role).toBe(false);
            // The unowned pool is nobody's.
            expect(canExportLeadHistory({ role, userId: ME, currentOwnerId: null }), role).toBe(false);
        }
    });

    it("history export: a manager may export any lead, owned by anyone or no one", () => {
        for (const role of ["admin", "ceo", "sales_head", "sales_manager", "business_head"]) {
            expect(canExportLeadHistory({ role, userId: ME, currentOwnerId: OTHER }), role).toBe(true);
            expect(canExportLeadHistory({ role, userId: ME, currentOwnerId: null }), role).toBe(true);
        }
    });

    it("history export: a role outside the export list never may, even on its own lead", () => {
        for (const role of ["sales_executive", "sales_insight", "finance_controller", "dealer", "", null, undefined]) {
            expect(canExportLeadHistory({ role, userId: ME, currentOwnerId: ME }), String(role)).toBe(false);
        }
    });

    it("no signed-in id never matches an unowned lead", () => {
        expect(canExportLeadHistory({ role: "asm", userId: null, currentOwnerId: null })).toBe(false);
        expect(canExportLeadHistory({ role: "asm", userId: undefined, currentOwnerId: undefined })).toBe(false);
    });

    it("every own-only role is one the history export admits at all", () => {
        for (const r of ["asm", "inside_sales_rep", "partner"]) {
            expect((LEAD_HISTORY_EXPORT_ROLES as readonly string[]).includes(r), r).toBe(true);
        }
    });
});
