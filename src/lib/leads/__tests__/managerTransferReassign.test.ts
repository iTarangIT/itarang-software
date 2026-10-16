import { describe, expect, it } from "vitest";

import { canReassignToIsr, canTransferAnyLead, LEADS_BULK_ROLES, managerMayTransferStatus } from "../access";
import { isOpen, type LeadStatus } from "@/lib/lifecycle/transitions";

const may = (s: LeadStatus | null) => managerMayTransferStatus(s, s == null || isOpen(s));

describe("ID 179 — manager Transfer to ASM and Reassign to ISR", () => {
    it("a manager's Transfer is hidden on Won and on a lead already with an ASM", () => {
        expect(may("Won")).toBe(false);
        expect(may("Transferred_to_ASM")).toBe(false);
    });

    it("…and on a closed lead, but offered on a lead still being worked", () => {
        expect(may("Lost")).toBe(false);
        expect(may("Converted")).toBe(false);
        expect(may("Under_Discussion")).toBe(true);
        expect(may("Commercials_Finalised")).toBe(true);
        expect(may(null)).toBe(true);
    });

    it("Reassign to ISR follows the Leads page bulk-reassign roles", () => {
        for (const r of LEADS_BULK_ROLES) expect(canReassignToIsr(r)).toBe(true);
        expect(canReassignToIsr("admin")).toBe(true);
        expect(canReassignToIsr("sales_head")).toBe(true);
        expect(canReassignToIsr("ceo")).toBe(true);
        expect(canReassignToIsr("inside_sales_rep")).toBe(false);
        expect(canReassignToIsr("asm")).toBe(false);
        expect(canReassignToIsr(null)).toBe(false);
    });

    it("Transfer-any-lead roles are unchanged", () => {
        expect(canTransferAnyLead("sales_head")).toBe(true);
        expect(canTransferAnyLead("inside_sales_rep")).toBe(false);
    });
});
