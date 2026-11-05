import { describe, expect, it } from "vitest";
import { callbackDueAt, callbackDueDetail, firstOpeningNextWorkingDay, hasPartOfDay } from "../callCategory";
import { buildCallbackBrief, briefLines } from "../callbackBrief";
import { onTimePct } from "../callbackBrief";

// 5 Nov 2026 is a Thursday. IST = UTC + 5:30.
const ist = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 10, day, hh, mm) - 330 * 60_000);
const iso = (d: Date) => d.toISOString();
const window = { start: "10:00", end: "19:00", days: ["mon", "tue", "wed", "thu", "fri", "sat"] };
const now = ist(5, 12, 0);

const detail = (extra: Partial<Parameters<typeof callbackDueDetail>[0]>) =>
    callbackDueDetail({ owner: "sales", now, window, ...extra });

describe("callbackDueDetail — never a silent 11:00", () => {
    it("a bare 'kal' names a day, not a time: flagged, due at tomorrow's window opening", () => {
        const d = detail({ callbackWhen: "kal" });
        expect(d.timeSet).toBe(false);
        expect(iso(d.at)).toBe(iso(ist(6, 10, 0)));
    });

    it("nothing said at all: flagged, due at the next working day's opening", () => {
        const d = detail({});
        expect(d.timeSet).toBe(false);
        expect(iso(d.at)).toBe(iso(ist(6, 10, 0)));
    });

    it("Saturday with nothing said → Monday's opening (Sunday is not a working day)", () => {
        const d = callbackDueDetail({ owner: "sales", now: ist(7, 15), window });
        expect(iso(d.at)).toBe(iso(ist(9, 10, 0)));
        expect(iso(firstOpeningNextWorkingDay(ist(7, 15), window))).toBe(iso(ist(9, 10, 0)));
    });

    it("a clock time is set: 'kal 5 baje' → tomorrow 17:00", () => {
        const d = detail({ callbackWhen: "kal 5 baje" });
        expect(d.timeSet).toBe(true);
        expect(iso(d.at)).toBe(iso(ist(6, 17, 0)));
    });

    it("a part of the day is set: 'kal shaam ko' → tomorrow 17:00", () => {
        const d = detail({ callbackWhen: "kal shaam ko" });
        expect(d.timeSet).toBe(true);
        expect(iso(d.at)).toBe(iso(ist(6, 17, 0)));
    });

    it("an hour delay is set: '2 ghante baad'", () => {
        expect(detail({ callbackWhen: "2 ghante baad" }).timeSet).toBe(true);
        expect(detail({ callbackWhen: "thodi der mein" }).timeSet).toBe(true);
    });

    it("a day count is not a time: '2 din baad'", () => {
        expect(detail({ callbackWhen: "2 din baad" }).timeSet).toBe(false);
    });

    it("the model's own 'tomorrow 11:00' does not count when the dealer only said 'kal'", () => {
        const d = detail({ callbackWhen: "kal", callbackAt: ist(6, 11).toISOString() });
        expect(d.timeSet).toBe(false);
        expect(iso(d.at)).toBe(iso(ist(6, 10, 0)));
    });

    it("the dealer's time in the transcript counts even when callback_when is empty", () => {
        const t = "agent: Kab call karein?\nuser: Kal subah call kar lena";
        const d = detail({ transcript: t });
        expect(d.timeSet).toBe(true);
    });

    it("Priya's own words in the transcript do not set the time", () => {
        const t = "agent: Main kal 11 baje call karungi\nuser: haan theek hai";
        expect(detail({ transcript: t }).timeSet).toBe(false);
    });

    it("an AI-owned callback keeps the old due time (no window-opening move), flagged", () => {
        const d = callbackDueDetail({ owner: "ai", now, window, callbackWhen: "kal" });
        expect(d.timeSet).toBe(false);
        expect(iso(d.at)).toBe(iso(callbackDueAt({ owner: "ai", now, window, callbackWhen: "kal" })));
    });

    it("hasPartOfDay", () => {
        for (const t of ["subah", "शाम को", "dopahar", "evening", "raat 8 baje"]) expect(hasPartOfDay(t), t).toBe(true);
        for (const t of ["kal", "parso", "", null]) expect(hasPartOfDay(t), String(t)).toBe(false);
    });
});

describe("the brief says so", () => {
    const base = {
        kind: "sales" as const,
        shop: "Sharma Batteries",
        city: "Patna",
        leadPhone: "+919876543210",
        dueAt: ist(6, 10),
    };

    it("time not set → the promise line says to agree a time; the flag is on", () => {
        const b = buildCallbackBrief({ ...base, callbackWhen: "kal", timeSet: false });
        expect(b.timeNotSet).toBe(true);
        expect(b.promise).toMatch(/^Time not set/);
        expect(b.promise).toContain("“kal”");
        expect(briefLines(b).some((l) => l.startsWith("Time not set"))).toBe(true);
    });

    it("a set time keeps the old wording", () => {
        const b = buildCallbackBrief({ ...base, callbackWhen: "kal 5 baje", timeSet: true });
        expect(b.timeNotSet).toBe(false);
        expect(b.promise).toMatch(/^Priya promised a call/);
    });

    it("a Qualified lead with no callback is always time-not-set", () => {
        expect(buildCallbackBrief({ ...base, kind: "qualified" }).timeNotSet).toBe(true);
    });

    it("omitting timeSet (older callers) behaves as set", () => {
        expect(buildCallbackBrief({ ...base }).timeNotSet).toBe(false);
    });
});

describe("onTimePct — promised callbacks made within 30 min", () => {
    it.each([
        [3, 4, 75],
        [0, 5, 0],
        [2, 3, 66.7],
        [5, 5, 100],
    ])("%d of %d → %d%%", (on, due, pct) => {
        expect(onTimePct(on, due)).toBe(pct);
    });

    it("nothing due → null, never a divide by zero; on-time is capped at due", () => {
        expect(onTimePct(0, 0)).toBeNull();
        expect(onTimePct(3, -1)).toBeNull();
        expect(onTimePct(7, 5)).toBe(100);
    });
});
