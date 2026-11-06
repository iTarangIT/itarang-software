import { describe, expect, it } from "vitest";
import {
    callerKey,
    inboundBranch,
    inboundDynamicVariables,
    inboundFollowUp,
    INBOUND_RETURN_MS,
    type InboundMatch,
} from "../inboundContext";

const ist = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 10, day, hh, mm) - 330 * 60_000);
const now = ist(5, 12);
const lead = { id: "L1", shopName: "Sharma Batteries", dealerName: "Ramesh Sharma", language: "Hindi", city: "Patna" };
const cb = (extra: Partial<NonNullable<InboundMatch["openCallback"]>> = {}) => ({
    id: "cb1",
    kind: "sales",
    dueAt: ist(5, 17),
    timeNotSet: false,
    assignedName: "Nidhi",
    requestedText: "shaam 5 baje",
    ...extra,
});
const human = { l1: "Connected", l2: "Cold", l3: "Need Some Time", at: ist(4, 11) };
const machine = { l1: "Connected", l2: "Machine", l3: "Dead audio (no sound either way)", at: ist(4, 11) };
const notConnected = { l1: "Not Connected", l2: "Did not pick", l3: null, at: ist(4, 11) };

describe("inboundBranch", () => {
    it("unknown number → unknown", () => {
        expect(inboundBranch({ lead: null, openCallback: null, lastOutcome: null }, now)).toBe("unknown");
    });

    it("an open callback still ahead → confirm the slot", () => {
        expect(inboundBranch({ lead, openCallback: cb(), lastOutcome: human }, now)).toBe("confirm_slot");
    });

    it("an open callback already due → do it now", () => {
        expect(inboundBranch({ lead, openCallback: cb({ dueAt: ist(5, 11) }), lastOutcome: human }, now)).toBe("do_it_now");
    });

    it("an open callback with no time agreed → do it now (there is no slot to confirm)", () => {
        expect(inboundBranch({ lead, openCallback: cb({ timeNotSet: true }), lastOutcome: human }, now)).toBe("do_it_now");
    });

    it("a complaint callback, or a last call that was a complaint → complaint, whatever else is open", () => {
        expect(inboundBranch({ lead, openCallback: cb({ kind: "complaint" }), lastOutcome: null }, now)).toBe("complaint");
        const lastComplaint = { ...human, l3: "Bad Experience with Trontek" };
        expect(inboundBranch({ lead, openCallback: null, lastOutcome: lastComplaint }, now)).toBe("complaint");
    });

    it("dialled but no conversation (machine, not connected, or never dialled) → warm opener", () => {
        expect(inboundBranch({ lead, openCallback: null, lastOutcome: machine }, now)).toBe("warm_opener");
        expect(inboundBranch({ lead, openCallback: null, lastOutcome: notConnected }, now)).toBe("warm_opener");
        expect(inboundBranch({ lead, openCallback: null, lastOutcome: null }, now)).toBe("warm_opener");
    });

    it("spoke to Priya, nothing booked → do it now", () => {
        expect(inboundBranch({ lead, openCallback: null, lastOutcome: human }, now)).toBe("do_it_now");
    });
});

describe("inboundDynamicVariables", () => {
    it("every key is present; no owner_name is ever sent", () => {
        const v = inboundDynamicVariables({ lead: null, openCallback: null, lastOutcome: null }, "+919971027907", now);
        expect(v).toMatchObject({ inbound: "1", inbound_branch: "unknown", lead_id: "", shop_name: "", owner_name: "", is_probe: "0" });
        for (const k of ["callback_slot_text", "isr_name", "last_outcome", "language", "location"]) expect(v[k], k).toBe("");
    });

    it("carries the slot, the ISR and the last outcome", () => {
        const v = inboundDynamicVariables({ lead, openCallback: cb(), lastOutcome: human }, "9971027907", now);
        expect(v.inbound_branch).toBe("confirm_slot");
        expect(v.shop_name).toBe("Sharma Batteries");
        expect(v.isr_name).toBe("Nidhi");
        expect(v.callback_slot_text).toMatch(/5:00\s?pm/i);
        expect(v.callback_time_set).toBe("1");
        expect(v.last_outcome).toBe("Need Some Time");
        expect(v.owner_name).toBe("");
    });

    it("a time-not-set callback sends no slot text", () => {
        const v = inboundDynamicVariables({ lead, openCallback: cb({ timeNotSet: true }), lastOutcome: null }, "9971027907", now);
        expect(v.callback_slot_text).toBe("");
        expect(v.callback_time_set).toBe("0");
    });

    it("a not-connected last outcome names its L2", () => {
        const v = inboundDynamicVariables({ lead, openCallback: null, lastOutcome: notConnected }, "9971027907", now);
        expect(v.last_outcome).toBe("Did not pick");
    });
});

describe("callerKey", () => {
    it.each([
        ["+919971027907", "9971027907"],
        ["09971027907", "9971027907"],
        ["9971027907", "9971027907"],
        ["+91 99710-27907", "9971027907"],
        ["08035315136", "8035315136"],
        ["12345", null],
        ["", null],
        [null, null],
    ])("%s → %s", (raw, key) => {
        expect(callerKey(raw)).toBe(key);
    });
});

describe("inboundFollowUp", () => {
    const base = { branch: "confirm_slot" as const, answered: true, callResult: null, callbackAgreed: null, agreedAt: null, now };

    it("not answered → an ISR returns it within 10 minutes", () => {
        expect(inboundFollowUp({ ...base, answered: false })).toEqual({ kind: "return_call", dueAt: new Date(now.getTime() + INBOUND_RETURN_MS) });
    });

    it("unanswered beats everything, even a complaint branch", () => {
        expect(inboundFollowUp({ ...base, branch: "complaint", answered: false }).kind).toBe("return_call");
    });

    it("a complaint (branch or this call's result) → complaint", () => {
        expect(inboundFollowUp({ ...base, branch: "complaint" }).kind).toBe("complaint");
        expect(inboundFollowUp({ ...base, branch: "warm_opener", callResult: "complaint" }).kind).toBe("complaint");
    });

    it("a new time agreed → rebook at it; a past time is ignored", () => {
        expect(inboundFollowUp({ ...base, agreedAt: ist(6, 11) })).toEqual({ kind: "rebook", dueAt: ist(6, 11) });
        expect(inboundFollowUp({ ...base, agreedAt: ist(5, 9), callbackAgreed: true }).kind).toBe("confirmed");
    });

    it("confirmed the slot he has → confirmed (keep the time)", () => {
        expect(inboundFollowUp({ ...base, callbackAgreed: true }).kind).toBe("confirmed");
    });

    it("talked, no confirmation → the ISR calls now (10 min)", () => {
        expect(inboundFollowUp({ ...base, branch: "warm_opener" }).kind).toBe("call_now");
        expect(inboundFollowUp({ ...base, branch: "do_it_now", callbackAgreed: true }).kind).toBe("call_now");
    });
});
