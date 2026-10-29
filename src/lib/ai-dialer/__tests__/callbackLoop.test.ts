// D8 — the callback loop's pure parts: the round-robin pick, the call brief,
// and the "a person owes him a call" enrolment skip.

import { describe, expect, it } from "vitest";
import { briefLines, buildCallbackBrief, pickInTurn } from "@/lib/ai-dialer/callbackBrief";
import { planEnrolment } from "@/lib/ai-dialer/numberHygiene";

const ist = (s: string) => new Date(`${s}+05:30`);

describe("pickInTurn", () => {
    it("takes the callback owners in turn, Nidhi first", () => {
        const owners = ["nidhi", "kapil", "ravi"];
        expect([0, 1, 2, 3, 4].map((c) => pickInTurn(owners, c))).toEqual(["nidhi", "kapil", "ravi", "nidhi", "kapil"]);
        expect(pickInTurn([], 3)).toBeNull();
    });
});

describe("buildCallbackBrief", () => {
    const transcript = [
        "agent: नमस्ते sir, Priya iTarang से।",
        "user: हाँ, rate क्या रहेगा? EMI भी चाहिए। मेरे भाई का number लिख लो 9876501234.",
        "user: कल शाम को call करना।",
    ].join("\n");

    it("says what the call is for, what was promised, and what was left open", () => {
        const b = buildCallbackBrief({
            kind: "sales",
            shop: "Shree Batteries",
            city: "Patna",
            leadPhone: "+919811022422",
            productLines: ["three_wheeler", "inverter_battery"],
            volumeEvidence: "20 sets a month",
            callbackWhen: "kal shaam",
            dueAt: ist("2026-10-30T17:00:00"),
            transcript,
            summary: "Lead-acid e-rickshaw dealer, wants the rate.",
        });
        expect(b.purpose).toBe("Give the rate and the finance scheme, and agree the next step.");
        expect(b.productLines).toEqual(["E-rickshaw / e-auto", "Inverter battery"]);
        expect(b.openQuestions).toEqual(["Price", "EMI / finance"]);
        expect(b.secondNumber).toBe("9876501234");
        expect(b.promise).toContain("kal shaam");
        expect(briefLines(b)[0]).toBe(b.purpose);
        expect(briefLines(b)).toContain("Shree Batteries, Patna");
    });

    it("a complaint brief never pitches", () => {
        const b = buildCallbackBrief({ kind: "complaint", shop: null, city: null, leadPhone: null, dueAt: new Date() });
        expect(b.purpose).toMatch(/^Do not pitch\./);
    });

    it("a qualified lead's brief says no time was agreed", () => {
        const b = buildCallbackBrief({ kind: "qualified", shop: null, city: null, leadPhone: null, dueAt: new Date() });
        expect(b.promise).toMatch(/^No time agreed/);
    });

    it("the lead's own number is not a second number", () => {
        const b = buildCallbackBrief({
            kind: "sales",
            shop: null,
            city: null,
            leadPhone: "9876501234",
            dueAt: new Date(),
            transcript: "user: mera number 9876501234 hai",
        });
        expect(b.secondNumber).toBeNull();
    });
});

describe("no double calling", () => {
    it("a lead with an open promised callback is not enrolled", () => {
        const out = planEnrolment([
            { id: "a", phone: "+919811022422", name: null, openCallback: true },
            { id: "b", phone: "+917000123456", name: null },
        ]);
        expect(out.map((d) => d.skip)).toEqual(["open_callback", null]);
    });
});
