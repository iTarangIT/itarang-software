import { describe, expect, it } from "vitest";
import { autoProgressForCall, autoProgressForVisit, bucketForLabel } from "../autoProgress";

// The shared auto status / temperature rule (user decision 2026-09-26): one
// rule for the CRM's Log Touchpoint / Log Visit AND the WhatsApp Assistant.
// Status only moves forward; temperature follows the latest outcome.

describe("bucketForLabel", () => {
    it("a label in one bucket → that bucket; in two (Commercials Explained) → null", () => {
        expect(bucketForLabel("Details Shared")).toBe("Warm");
        expect(bucketForLabel("Need Some Time")).toBe("Cold");
        expect(bucketForLabel("Quotation Sent")).toBe("Hot");
        expect(bucketForLabel("Commercials Explained")).toBeNull();
        expect(bucketForLabel("Did not pick")).toBeNull();
    });
});

describe("autoProgressForCall", () => {
    const call = (label: string, over: Partial<Parameters<typeof autoProgressForCall>[0]> = {}) =>
        autoProgressForCall({ connected: true, label, bucket: null, currentStatus: "Assigned_Not_Contacted", currentInterest: null, ...over });

    it.each([
        ["Need Some Time", "Under_Discussion", "cold"],
        ["Details Shared", "Under_Discussion", "warm"],
        // ID 75: commercials outcomes are first contact only — the quote moves the stage.
        ["Quotation Sent", "Under_Discussion", "hot"],
        ["Under Negotiation", "Under_Discussion", "hot"],
        ["Commercials Finalised", "Under_Discussion", "hot"],
    ])("connected · %s → %s, %s", (label, status, interest) => {
        expect(call(label)).toEqual({ statusTo: status, interestTo: interest });
    });

    it("Commercials Explained: first contact only (ID 75), temperature from the stated bucket only", () => {
        expect(call("Commercials Explained")).toEqual({ statusTo: "Under_Discussion", interestTo: null });
        expect(call("Commercials Explained", { bucket: "Hot" })).toEqual({ statusTo: "Under_Discussion", interestTo: "hot" });
    });

    it("not connected → nothing", () => {
        expect(call("Did not pick", { connected: false })).toEqual({ statusTo: null, interestTo: null });
    });

    it("Lost / Converted buckets are left to their own flows", () => {
        expect(call("Not Interested", { bucket: "Lost" })).toEqual({ statusTo: null, interestTo: null });
        expect(call("Deal Closed", { bucket: "Converted" })).toEqual({ statusTo: null, interestTo: null });
    });

    it("status never moves backwards, never touches terminal, same value → null", () => {
        expect(call("Details Shared", { currentStatus: "Commercials_Explained" }).statusTo).toBeNull();
        expect(call("Quotation Sent", { currentStatus: "Commercials_Finalised" }).statusTo).toBeNull();
        expect(call("Commercials Finalised", { currentStatus: "Awaiting_Customer_Decision" }).statusTo).toBeNull();
        expect(call("Details Shared", { currentStatus: "Converted" }).statusTo).toBeNull();
        expect(call("Details Shared", { currentStatus: "Lost" }).statusTo).toBeNull();
        expect(call("Details Shared", { currentStatus: "Under_Discussion" }).statusTo).toBeNull();
        expect(call("Details Shared", { currentInterest: "warm" }).interestTo).toBeNull();
    });

    it("temperature follows the latest call, down as well as up", () => {
        expect(call("Need Some Time", { currentInterest: "hot" }).interestTo).toBe("cold");
    });

    it("a call never ends Awaiting field visit (ID 77)", () => {
        expect(call("Details Shared", { currentStatus: "Transferred_to_ASM" }).statusTo).toBeNull();
    });
});

describe("autoProgressForVisit", () => {
    const visit = (outcome: string, over: Partial<Parameters<typeof autoProgressForVisit>[0]> = {}) =>
        autoProgressForVisit({ visited: true, outcome: outcome as never, currentStatus: "Transferred_to_ASM", currentInterest: "warm", ...over });

    it("productive → Under Discussion, temperature as said", () => {
        expect(visit("productive")).toEqual({ statusTo: "Under_Discussion", interestTo: null });
    });
    it("commercials progressed → hot; status is first contact only (ID 75)", () => {
        expect(visit("commercials_progressed")).toEqual({ statusTo: "Under_Discussion", interestTo: "hot" });
    });
    it("dealer uninterested → cold (keep open / Lost is asked)", () => {
        expect(visit("dealer_uninterested")).toEqual({ statusTo: null, interestTo: "cold" });
    });
    it("dealer not present, or no visit → nothing", () => {
        expect(visit("dealer_not_present")).toEqual({ statusTo: null, interestTo: null });
        expect(visit("productive", { visited: false })).toEqual({ statusTo: null, interestTo: null });
    });
});

describe("follow-ups (ID 80)", () => {
    it("there is no auto rule for a follow-up: a note moves nothing", async () => {
        expect(Object.keys(await import("@/lib/leads/autoProgress"))).not.toContain("autoProgressForFollowUp");
    });
});
