import { describe, expect, it } from "vitest";

import {
    actorLabel,
    kycCardLabel,
    kycDecisionLine,
    kycEventMessage,
    kycRecipients,
    waNumber,
} from "../kycEventText";

describe("actorLabel", () => {
    it("names the person and their role", () => {
        expect(actorLabel({ id: "u1", name: "Anirudh", role: "sales_head" })).toBe("Anirudh (Sales Head)");
        expect(actorLabel({ id: "u2", name: "Ravi", role: "dealer" })).toBe("Ravi (Dealer)");
    });
    it("calls the system iTarang (automatic)", () => {
        expect(actorLabel({ id: null, name: null, role: "system" })).toBe("iTarang (automatic)");
        expect(actorLabel({ id: null, name: null, role: null })).toBe("iTarang (automatic)");
    });
});

describe("kycDecisionLine", () => {
    it("words approve / reject / more docs the same everywhere", () => {
        expect(kycDecisionLine("PAN check", "accept")).toBe("PAN check approved");
        expect(kycDecisionLine("Customer consent", "verified")).toBe("Customer consent approved");
        expect(kycDecisionLine("PAN check", "reject", "name mismatch")).toBe("PAN check rejected: name mismatch");
        expect(kycDecisionLine("Customer consent", "admin_rejected")).toBe("Customer consent rejected");
        expect(kycDecisionLine("Bank check", "request_more_docs", "statement unclear")).toBe(
            "Bank check: more documents requested: statement unclear",
        );
    });
});

describe("kycCardLabel", () => {
    it("labels cards and marks the co-borrower", () => {
        expect(kycCardLabel("pan")).toBe("PAN");
        expect(kycCardLabel("bank_account")).toBe("Bank account");
        expect(kycCardLabel("aadhaar", "co_borrower")).toBe("Aadhaar (co-borrower)");
        expect(kycCardLabel("pan", "primary")).toBe("PAN");
    });
});

describe("kycEventMessage", () => {
    it("carries customer, ref, action, actor and IST time", () => {
        const m = kycEventMessage({
            customerName: "Ramesh",
            referenceId: "L-101",
            action: "PAN check approved",
            actor: "Anirudh (Sales Head)",
            at: new Date("2026-10-26T09:35:00Z"),
        });
        expect(m).toContain("Ramesh (Ref: L-101)");
        expect(m).toContain("PAN check approved");
        expect(m).toContain("By: Anirudh (Sales Head)");
        expect(m).toMatch(/At: 26 Oct 2026, 3:05\s?pm/i);
    });
});

describe("waNumber / kycRecipients", () => {
    it("normalises Indian numbers", () => {
        expect(waNumber("98765 43210")).toBe("919876543210");
        expect(waNumber("+91-98765-43210")).toBe("919876543210");
        expect(waNumber("09876543210")).toBe("919876543210");
        expect(waNumber("12345")).toBeNull();
        expect(waNumber(null)).toBeNull();
    });

    it("de-dupes numbers and leaves out the person who acted", () => {
        const to = kycRecipients(
            [
                { user_id: "admin1", phone: "9876543210" },
                { user_id: "admin2", phone: "+91 98765 43210" }, // same number twice
                { user_id: "actor", phone: "9000000001" },
                { user_id: "house", phone: "9000000001" }, // shares the actor's phone
                { user_id: "sh", phone: "9111111111" },
                { user_id: "nophone", phone: null },
            ],
            { id: "actor", phone: "9000000001" },
        );
        expect(to).toEqual(["919876543210", "919111111111"]);
    });
});
