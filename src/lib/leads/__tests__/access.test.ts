import { describe, expect, it } from "vitest";
import {
    LEAD_HISTORY_EXPORT_ROLES,
    canEditLead,
    canEditRegionGroup,
    canExportLeadHistory,
    exportsOwnLeadsOnly,
} from "../access";

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

describe("region groups — edit and delete are for oversight roles and the creator (ID 118)", () => {
    it("an oversight role may change any group, whoever saved it", () => {
        for (const role of ["admin", "ceo", "sales_head", "business_head", "sales_manager", "partner"]) {
            expect(canEditRegionGroup({ role, userId: ME, createdBy: OTHER }), role).toBe(true);
            expect(canEditRegionGroup({ role, userId: ME, createdBy: null }), role).toBe(true);
        }
    });

    it("a rep or ASM may change only a group they saved", () => {
        for (const role of ["inside_sales_rep", "asm", "sales_executive", "sales_insight", "finance_controller"]) {
            expect(canEditRegionGroup({ role, userId: ME, createdBy: ME }), role).toBe(true);
            expect(canEditRegionGroup({ role, userId: ME, createdBy: OTHER }), role).toBe(false);
            // Seeds and pre-ID-118 groups have no recorded creator.
            expect(canEditRegionGroup({ role, userId: ME, createdBy: null }), role).toBe(false);
        }
    });

    it("no signed-in id never matches a group with no creator", () => {
        expect(canEditRegionGroup({ role: "asm", userId: null, createdBy: null })).toBe(false);
        expect(canEditRegionGroup({ role: "asm", userId: undefined, createdBy: undefined })).toBe(false);
    });
});

describe("Edit Lead — the owner, the assigned ASM, or a manager (ID 132)", () => {
    const lead = { currentOwnerId: OTHER, asmId: null };

    it("a manager may edit any lead", () => {
        for (const role of ["admin", "ceo", "sales_head", "business_head", "sales_manager", "partner"]) {
            expect(canEditLead({ role, userId: ME, ...lead }), role).toBe(true);
            expect(canEditLead({ role, userId: ME, currentOwnerId: null, asmId: null }), role).toBe(true);
        }
    });

    it("a rep or ASM may not edit a lead another rep owns", () => {
        for (const role of ["asm", "inside_sales_rep", "sales_executive", "sales_insight", "finance_controller"]) {
            expect(canEditLead({ role, userId: ME, ...lead }), role).toBe(false);
            // The unowned pool is nobody's to edit.
            expect(canEditLead({ role, userId: ME, currentOwnerId: null, asmId: null }), role).toBe(false);
        }
    });

    it("the current owner may edit, and so may the assigned ASM", () => {
        expect(canEditLead({ role: "inside_sales_rep", userId: ME, currentOwnerId: ME, asmId: null })).toBe(true);
        expect(canEditLead({ role: "asm", userId: ME, currentOwnerId: OTHER, asmId: ME })).toBe(true);
        expect(canEditLead({ role: "asm", userId: ME, currentOwnerId: OTHER, asmId: OTHER })).toBe(false);
    });

    it("a role outside /leads never may, even on its own lead", () => {
        for (const role of ["dealer", "nbfc_partner", "service_engineer", "", null, undefined]) {
            expect(canEditLead({ role, userId: ME, currentOwnerId: ME, asmId: ME }), String(role)).toBe(false);
        }
    });

    it("no signed-in id never matches an unowned lead", () => {
        expect(canEditLead({ role: "asm", userId: null, currentOwnerId: null, asmId: null })).toBe(false);
        expect(canEditLead({ role: "asm", userId: undefined, currentOwnerId: undefined, asmId: undefined })).toBe(false);
    });
});
