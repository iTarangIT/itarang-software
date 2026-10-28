/**
 * ID 201 (Kartik, 27 Oct) — the KYC action log's actor type, channel, tags,
 * and what the owning dealer sees ("iTarang team", never a staff name).
 */
import { describe, expect, it } from "vitest";

import {
    actorLabel,
    ITARANG_TEAM,
    kycActorType,
    kycChannel,
    kycCheckOutcome,
    kycLineTags,
    kycRowsForViewer,
    kycViewerOf,
    kycWhoFor,
    type KycActorType,
} from "../kycEventText";
import { dealerFacingDoneByLine, doneByLine } from "@/lib/leads/actForDealer";

describe("kycActorType / kycChannel (#1)", () => {
    it("works out the type from the login when the caller did not say", () => {
        expect(kycActorType({ id: null, role: null })).toBe("system");
        expect(kycActorType({ id: null, role: "system" })).toBe("system");
        expect(kycActorType({ id: "u", role: "dealer" })).toBe("dealer");
        expect(kycActorType({ id: "u", role: "sales_head" })).toBe("itarang");
        expect(kycActorType({ id: "u", role: "admin" })).toBe("itarang");
        expect(kycActorType({ id: null, role: "salesperson" })).toBe("salesperson");
    });
    it("keeps the type the caller gave (the house login has role dealer)", () => {
        expect(kycActorType({ id: "u", role: "dealer", type: "house" })).toBe("house");
    });
    it("is web for a person, system for the system, unless told", () => {
        expect(kycChannel({ id: "u", role: "admin" })).toBe("web");
        expect(kycChannel({ id: null, role: null })).toBe("system");
        expect(kycChannel({ id: "u", role: "dealer", channel: "whatsapp" })).toBe("whatsapp");
    });
});

describe("actorLabel for the WhatsApp message to staff", () => {
    it("tells the house apart from the file's dealer", () => {
        expect(actorLabel({ id: "u", name: "Neha", role: "dealer", type: "house" })).toBe("Neha (iTarang house)");
        expect(actorLabel({ id: "u", name: "Ravi", role: "dealer" })).toBe("Ravi (Dealer)");
        expect(actorLabel({ id: null, name: "Ramesh", role: "salesperson", type: "salesperson" })).toBe(
            "Ramesh (dealer's salesperson)",
        );
    });
});

describe("kycLineTags (#5)", () => {
    const tags = (channel: "web" | "whatsapp" | "system", actorType: KycActorType, forDealerName: string | null = null) =>
        kycLineTags({ channel, actorType, forDealerName });
    it("shows Web or WhatsApp on every person's line", () => {
        expect(tags("web", "dealer")).toEqual(["Web"]);
        expect(tags("whatsapp", "dealer")).toEqual(["WhatsApp"]);
        expect(tags("system", "system")).toEqual([]);
    });
    it("shows iTarang house and the dealer acted for", () => {
        expect(tags("web", "house", "Sharma Batteries")).toEqual(["Web", "iTarang house", "for Sharma Batteries"]);
        expect(tags("whatsapp", "itarang", "Sharma Batteries")).toEqual(["WhatsApp", "for Sharma Batteries"]);
    });
    it("never says 'for' on the dealer's own line", () => {
        expect(tags("web", "dealer", "Sharma Batteries")).toEqual(["Web"]);
    });
});

describe("what each viewer sees (#6)", () => {
    const rows = [
        { byName: "Anirudh", byRole: "sales_head", actorType: "itarang" as const },
        { byName: "Neha", byRole: "dealer", actorType: "house" as const },
        { byName: "Ravi", byRole: "dealer", actorType: "dealer" as const },
        { byName: "Ramesh", byRole: "salesperson", actorType: "salesperson" as const },
        { byName: "iTarang (automatic)", byRole: "system", actorType: "system" as const },
    ];
    it("the owning dealer sees 'iTarang team' for staff and the house, and no role", () => {
        const seen = kycRowsForViewer(rows, "owning_dealer");
        expect(seen.map((r) => r.byName)).toEqual([ITARANG_TEAM, ITARANG_TEAM, "Ravi", "Ramesh", "iTarang (automatic)"]);
        expect(seen[0].byRole).toBeNull();
        expect(seen[1].byRole).toBeNull();
        expect(seen[2].byRole).toBe("dealer");
    });
    it("iTarang logins keep every name", () => {
        expect(kycRowsForViewer(rows, "itarang")).toEqual(rows);
        expect(kycWhoFor("itarang", rows[0])).toBe("Anirudh");
    });
    it("the house login reads as iTarang, the owning dealer's login as the dealer", () => {
        expect(kycViewerOf({ role: "dealer", dealer_id: "HOUSE" }, "HOUSE")).toBe("itarang");
        expect(kycViewerOf({ role: "dealer", dealer_id: "D-17" }, "HOUSE")).toBe("owning_dealer");
        expect(kycViewerOf({ role: "dealer", dealer_id: "D-17" }, null)).toBe("owning_dealer");
        expect(kycViewerOf({ role: "sales_head", dealer_id: null }, "HOUSE")).toBe("itarang");
        expect(kycViewerOf({ role: "admin", dealer_id: null }, "HOUSE")).toBe("itarang");
    });
    it("the help card and WhatsApp lines name the iTarang team, not the person", () => {
        expect(dealerFacingDoneByLine("ABC Motors")).toBe("Done by iTarang team for ABC Motors");
        expect(dealerFacingDoneByLine("ABC Motors")).not.toContain("Ravi");
        expect(doneByLine("Ravi", "ABC Motors")).toBe("Done by Ravi for ABC Motors");
    });
});

describe("kycCheckOutcome (#2)", () => {
    it("reads each provider result shape", () => {
        expect(kycCheckOutcome({ success: true })).toBe("passed");
        expect(kycCheckOutcome({ success: false, status: 409 })).toBe("failed");
        expect(kycCheckOutcome({ status: 200, body: { success: true } })).toBe("passed");
        expect(kycCheckOutcome({ status: 502, body: { success: true } })).toBe("failed");
        expect(kycCheckOutcome({ status: 200, body: { success: false } })).toBe("failed");
        expect(kycCheckOutcome({ ok: true })).toBe("passed");
        expect(kycCheckOutcome(null)).toBeNull();
        expect(kycCheckOutcome({ data: 1 })).toBeNull();
    });
});
