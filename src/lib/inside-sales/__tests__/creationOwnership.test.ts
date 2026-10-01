import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { creationOwnership } = await import("../createLead");
const { KEEPS_CREATED_LEAD_ROLES, keepsCreatedLead } = await import("../types");

describe("who keeps a lead they create (ID 83)", () => {
    it("an inside-sales rep, an ASM and the partner login keep it; an admin's goes to the pool", () => {
        for (const role of ["inside_sales_rep", "asm", "partner"]) {
            expect(creationOwnership(role).selfAssigns, role).toBe(true);
            expect(keepsCreatedLead(role), role).toBe(true);
        }
        for (const role of ["admin", "ceo", "sales_head", "sales_manager", ""]) {
            expect(creationOwnership(role).selfAssigns, role).toBe(false);
            expect(keepsCreatedLead(role), role).toBe(false);
        }
        expect(keepsCreatedLead(null)).toBe(false);
        expect(keepsCreatedLead(undefined)).toBe(false);
    });

    it("only an ASM's lead is a field lead (asm_id)", () => {
        expect(creationOwnership("asm")).toEqual({ selfAssigns: true, isAsm: true });
        expect(creationOwnership("inside_sales_rep")).toEqual({ selfAssigns: true, isAsm: false });
        expect(creationOwnership("partner")).toEqual({ selfAssigns: true, isAsm: false });
        expect(creationOwnership("admin")).toEqual({ selfAssigns: false, isAsm: false });
    });

    it("the writer and the screens read one list", () => {
        expect([...KEEPS_CREATED_LEAD_ROLES].sort()).toEqual(["asm", "inside_sales_rep", "partner"]);
    });
});
