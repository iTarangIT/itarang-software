import { describe, expect, it } from "vitest";
import { autoProgressForCall, autoProgressForFollowUp, autoProgressForVisit, bucketForLabel } from "../autoProgress";

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
        ["Quotation Sent", "Awaiting_Customer_Decision", "hot"],
        ["Under Negotiation", "Awaiting_Customer_Decision", "hot"],
        ["Commercials Finalised", "Commercials_Finalised", "hot"],
    ])("connected · %s → %s, %s", (label, status, interest) => {
        expect(call(label)).toEqual({ statusTo: status, interestTo: interest });
    });

    it("Commercials Explained: status auto, temperature from the stated bucket only", () => {
        expect(call("Commercials Explained")).toEqual({ statusTo: "Commercials_Explained", interestTo: null });
        expect(call("Commercials Explained", { bucket: "Hot" })).toEqual({ statusTo: "Commercials_Explained", interestTo: "hot" });
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
        expect(call("Commercials Finalised", { currentStatus: "Awaiting_Customer_Decision" }).statusTo).toBe("Commercials_Finalised");
        expect(call("Details Shared", { currentStatus: "Converted" }).statusTo).toBeNull();
        expect(call("Details Shared", { currentStatus: "Lost" }).statusTo).toBeNull();
        expect(call("Details Shared", { currentStatus: "Under_Discussion" }).statusTo).toBeNull();
        expect(call("Details Shared", { currentInterest: "warm" }).interestTo).toBeNull();
    });

    it("temperature follows the latest call, down as well as up", () => {
        expect(call("Need Some Time", { currentInterest: "hot" }).interestTo).toBe("cold");
    });

    it("an ASM's transferred lead still moves forward", () => {
        expect(call("Details Shared", { currentStatus: "Transferred_to_ASM" }).statusTo).toBe("Under_Discussion");
    });
});

describe("autoProgressForVisit", () => {
    const visit = (outcome: string, over: Partial<Parameters<typeof autoProgressForVisit>[0]> = {}) =>
        autoProgressForVisit({ visited: true, outcome: outcome as never, currentStatus: "Transferred_to_ASM", currentInterest: "warm", ...over });

    it("productive → Under Discussion, temperature as said", () => {
        expect(visit("productive")).toEqual({ statusTo: "Under_Discussion", interestTo: null });
    });
    it("commercials progressed → hot (status is asked)", () => {
        expect(visit("commercials_progressed")).toEqual({ statusTo: null, interestTo: "hot" });
    });
    it("dealer uninterested → cold (keep open / Lost is asked)", () => {
        expect(visit("dealer_uninterested")).toEqual({ statusTo: null, interestTo: "cold" });
    });
    it("dealer not present, or no visit → nothing", () => {
        expect(visit("dealer_not_present")).toEqual({ statusTo: null, interestTo: null });
        expect(visit("productive", { visited: false })).toEqual({ statusTo: null, interestTo: null });
    });
});

describe("autoProgressForFollowUp", () => {
    it("after a talk → Under Discussion; no talk → nothing", () => {
        expect(autoProgressForFollowUp({ spokeWithDealer: true, currentStatus: "Assigned_Not_Contacted" })).toEqual({ statusTo: "Under_Discussion", interestTo: null });
        expect(autoProgressForFollowUp({ spokeWithDealer: false, currentStatus: "Assigned_Not_Contacted" })).toEqual({ statusTo: null, interestTo: null });
        expect(autoProgressForFollowUp({ spokeWithDealer: true, currentStatus: "Commercials_Explained" }).statusTo).toBeNull();
    });
});
