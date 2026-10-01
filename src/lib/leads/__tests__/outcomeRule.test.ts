import { describe, expect, it } from "vitest";
import { autoProgressForCall, autoProgressForVisit } from "../autoProgress";
import { ALL_CONNECTED_DISPOSITIONS } from "../dispositions";
import { autoInterestAllowed, planOutcome, resolveOutcome, type OutcomeLead, type TouchpointOutcome } from "../outcomeRule";
import { checkStatusMove } from "@/lib/lifecycle/statusRules";
import { LEAD_STATUS } from "@/lib/lifecycle/transitions";
import { VISIT_OUTCOME } from "@/lib/asm/types";

const lead = (over: Partial<OutcomeLead> = {}): OutcomeLead => ({
    status: "Assigned_Not_Contacted",
    interest: "warm",
    preTransferStatus: null,
    ownerId: "rep-1",
    ...over,
});
const call = (over: Partial<Extract<TouchpointOutcome, { kind: "call" }>> = {}): TouchpointOutcome => ({
    kind: "call",
    connected: true,
    label: "Price High",
    bucket: null,
    ...over,
});
const AT = new Date("2026-10-01T06:00:00Z");

describe("resolveOutcome — calls", () => {
    it("is exactly the shared auto rule for a rep's call", () => {
        for (const label of ALL_CONNECTED_DISPOSITIONS) {
            for (const status of [null, ...LEAD_STATUS]) {
                const auto = autoProgressForCall({ connected: true, label, bucket: null, currentStatus: status, currentInterest: "warm" });
                expect(resolveOutcome(call({ label }), lead({ status })), `${label} @ ${status}`).toEqual({
                    statusTo: auto.statusTo,
                    event: "progress",
                    interestTo: auto.interestTo,
                });
            }
        }
    });

    it("a connected call is first contact and sets the bucket's temperature", () => {
        expect(resolveOutcome(call({ label: "Commercials Finalised" }), lead())).toEqual({
            statusTo: "Under_Discussion",
            event: "progress",
            interestTo: "hot",
        });
    });

    it("a call that did not connect moves nothing", () => {
        expect(resolveOutcome(call({ connected: false, label: "Switch off" }), lead())).toEqual({
            statusTo: null,
            event: "progress",
            interestTo: null,
        });
    });

    it("never names a commercials stage, whatever the outcome says (ID 75)", () => {
        for (const label of ["Commercials Explained", "Quotation Sent", "Under Negotiation", "Commercials Finalised"]) {
            expect(resolveOutcome(call({ label }), lead({ status: "Under_Discussion" })).statusTo, label).toBeNull();
        }
    });

    it("a Lost-type outcome moves nothing for a rep — Mark Lost is asked, not guessed", () => {
        expect(resolveOutcome(call({ label: "Not Interested" }), lead())).toMatchObject({ statusTo: null, interestTo: null });
    });

    describe("firstContactOnConnect (inbound systems)", () => {
        const inbound = (over: Partial<Extract<TouchpointOutcome, { kind: "call" }>> = {}) =>
            call({ firstContactOnConnect: true, ...over });

        it("any connected call is first contact: Lost-type label, no label, unknown label", () => {
            for (const label of ["Not Interested", null, "Sent Brochure Via Courier"]) {
                expect(resolveOutcome(inbound({ label }), lead()).statusTo, String(label)).toBe("Under_Discussion");
            }
        });

        it("lifts a lead with no status or a legacy status", () => {
            expect(resolveOutcome(inbound({ label: null }), lead({ status: null })).statusTo).toBe("Under_Discussion");
            expect(resolveOutcome(inbound({ label: null }), lead({ status: "hot" })).statusTo).toBe("Under_Discussion");
        });

        it("never ends Awaiting field visit, never moves back, never touches a closed lead", () => {
            for (const status of ["Transferred_to_ASM", "Under_Discussion", "Commercials_Explained", "Won", "Converted", "Lost"]) {
                expect(resolveOutcome(inbound({ label: null }), lead({ status })).statusTo, status).toBeNull();
            }
        });

        it("does nothing when the call did not connect", () => {
            expect(resolveOutcome(inbound({ connected: false, label: null }), lead()).statusTo).toBeNull();
        });

        it("gives no temperature without a bucket", () => {
            expect(resolveOutcome(inbound({ label: null }), lead()).interestTo).toBeNull();
        });
    });
});

describe("resolveOutcome — visits", () => {
    const visit = (over: Partial<Extract<TouchpointOutcome, { kind: "visit" }>> = {}): TouchpointOutcome => ({
        kind: "visit",
        visited: true,
        outcome: "productive",
        ...over,
    });

    it("a productive visit is first contact; commercials progressed also turns the lead hot", () => {
        expect(resolveOutcome(visit(), lead())).toEqual({ statusTo: "Under_Discussion", event: "visit", interestTo: null });
        expect(resolveOutcome(visit({ outcome: "commercials_progressed" }), lead())).toEqual({
            statusTo: "Under_Discussion",
            event: "visit",
            interestTo: "hot",
        });
    });

    it("an uninterested dealer turns cold and keeps the stage", () => {
        expect(resolveOutcome(visit({ outcome: "dealer_uninterested" }), lead({ status: "Under_Discussion" }))).toEqual({
            statusTo: null,
            event: "visit",
            interestTo: "cold",
        });
    });

    it("any done visit ends Awaiting field visit and restores the pre-transfer stage (ID 77)", () => {
        const awaiting = lead({ status: "Transferred_to_ASM", preTransferStatus: "Commercials_Finalised" });
        expect(resolveOutcome(visit({ outcome: "dealer_uninterested" }), awaiting).statusTo).toBe("Commercials_Finalised");
        expect(resolveOutcome(visit(), lead({ status: "Transferred_to_ASM" })).statusTo).toBe("Under_Discussion");
    });

    it("the ASM can ask for first contact only", () => {
        const quiet = visit({ outcome: "dealer_uninterested" });
        expect(resolveOutcome({ ...quiet, requested: "Under_Discussion" } as TouchpointOutcome, lead()).statusTo).toBe("Under_Discussion");
        expect(resolveOutcome({ ...quiet, requested: "Commercials_Explained" } as TouchpointOutcome, lead()).statusTo).toBeNull();
    });

    it("a visit that did not happen moves nothing", () => {
        expect(resolveOutcome(visit({ visited: false, outcome: null }), lead({ status: "Transferred_to_ASM" }))).toEqual({
            statusTo: null,
            event: "visit",
            interestTo: null,
        });
    });

    it("matches the shared auto rule's temperature for every outcome", () => {
        for (const outcome of VISIT_OUTCOME) {
            const auto = autoProgressForVisit({ visited: true, outcome, currentStatus: "Under_Discussion", currentInterest: "warm" });
            expect(resolveOutcome(visit({ outcome }), lead({ status: "Under_Discussion" })).interestTo, outcome).toBe(auto.interestTo);
        }
    });
});

describe("a derived move always passes the S3 guard", () => {
    it("for every call label × status, rep and inbound", () => {
        for (const label of [...ALL_CONNECTED_DISPOSITIONS, null]) {
            for (const status of [null, "legacy", ...LEAD_STATUS]) {
                for (const firstContactOnConnect of [false, true]) {
                    const r = resolveOutcome(call({ label, firstContactOnConnect }), lead({ status }));
                    if (!r.statusTo) continue;
                    expect(
                        checkStatusMove({ from: status, to: r.statusTo, event: r.event }),
                        `${label} @ ${status} (${firstContactOnConnect})`,
                    ).toEqual({ ok: true });
                }
            }
        }
    });

    it("for every visit outcome × status × pre-transfer stage", () => {
        for (const outcome of VISIT_OUTCOME) {
            for (const status of [null, ...LEAD_STATUS]) {
                for (const preTransferStatus of [null, "Under_Discussion", "Commercials_Finalised"]) {
                    const r = resolveOutcome(
                        { kind: "visit", visited: true, outcome, requested: "Under_Discussion" },
                        lead({ status, preTransferStatus }),
                    );
                    if (!r.statusTo) continue;
                    expect(checkStatusMove({ from: status, to: r.statusTo, event: r.event }), `${outcome} @ ${status}`).toEqual({ ok: true });
                }
            }
        }
    });
});

describe("autoInterestAllowed (P0-10)", () => {
    const ok = { actorId: "rep-1", performedAt: AT, lead: { status: "Under_Discussion", ownerId: "rep-1", interestChangedAt: null } };

    it("the owner's own work, or work on an unowned lead, may set the temperature", () => {
        expect(autoInterestAllowed(ok)).toBe(true);
        expect(autoInterestAllowed({ ...ok, lead: { ...ok.lead, ownerId: null } })).toBe(true);
    });

    it("no actor (unmapped NeoDove agent, AI) → no", () => {
        expect(autoInterestAllowed({ ...ok, actorId: null })).toBe(false);
    });

    it("someone else's call on an owned lead → no", () => {
        expect(autoInterestAllowed({ ...ok, actorId: "cc-agent" })).toBe(false);
    });

    it("a closed lead → no", () => {
        for (const status of ["Converted", "Lost"]) {
            expect(autoInterestAllowed({ ...ok, lead: { ...ok.lead, status } })).toBe(false);
        }
    });

    it("an outcome older than the lead's last temperature change → no", () => {
        const later = new Date(AT.getTime() + 60_000);
        expect(autoInterestAllowed({ ...ok, lead: { ...ok.lead, interestChangedAt: later } })).toBe(false);
        expect(autoInterestAllowed({ ...ok, lead: { ...ok.lead, interestChangedAt: AT } })).toBe(true);
    });
});

describe("planOutcome", () => {
    const base = { hasExplicitStatus: false, actorId: "rep-1", performedAt: AT, lead: lead() };

    it("derives status and temperature from the outcome", () => {
        expect(planOutcome({ ...base, outcome: call({ label: "Commercials Finalised" }) })).toEqual({
            statusTo: "Under_Discussion",
            event: "progress",
            interestTo: "hot",
        });
    });

    it("an explicit status change wins — nothing is applied twice", () => {
        expect(planOutcome({ ...base, hasExplicitStatus: true, outcome: call() }).statusTo).toBeNull();
    });

    it("interest null = leave it, even when the outcome proposes one", () => {
        expect(planOutcome({ ...base, interest: null, outcome: call({ label: "Commercials Finalised" }) }).interestTo).toBeNull();
    });

    it("a stated level is the rep's to set, with or without an outcome", () => {
        expect(planOutcome({ ...base, interest: "cold" }).interestTo).toBe("cold");
        expect(planOutcome({ ...base, interest: "cold", outcome: call({ label: "Commercials Finalised" }) }).interestTo).toBe("cold");
        // …but it is not a change when the lead is already there.
        expect(planOutcome({ ...base, interest: "warm" }).interestTo).toBeNull();
    });

    it("a derived temperature needs the owned-lead rule", () => {
        const hot = call({ label: "Commercials Finalised" });
        expect(planOutcome({ ...base, actorId: "cc-agent", outcome: hot })).toMatchObject({ statusTo: "Under_Discussion", interestTo: null });
        expect(planOutcome({ ...base, actorId: null, outcome: hot }).interestTo).toBeNull();
    });

    it("no outcome and no interest → nothing", () => {
        expect(planOutcome(base)).toEqual({ statusTo: null, event: "progress", interestTo: null });
    });
});
