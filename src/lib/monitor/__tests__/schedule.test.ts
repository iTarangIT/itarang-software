import { describe, expect, it } from "vitest";

import { istSlotState } from "@/lib/monitor/schedule";

// IST is UTC+5:30 and never observes DST, so every instant below is written as
// the UTC moment with the IST wall-clock it corresponds to in the comment.
const SLOT = { hour: 8, minute: 0 };

describe("istSlotState", () => {
    it("is not due before the slot time", () => {
        // 07:30 IST
        const s = istSlotState(new Date("2026-09-23T02:00:00Z"), SLOT);
        expect(s.istDate).toBe("2026-09-23");
        expect(s.due).toBe(false);
    });

    it("is due exactly at the slot time", () => {
        // 08:00 IST
        expect(istSlotState(new Date("2026-09-23T02:30:00Z"), SLOT).due).toBe(true);
    });

    it("stays due for the rest of the IST day", () => {
        // 19:30 IST — a box that was restarting at 08:00 must still send when it
        // comes back, rather than skipping the morning entirely. The claim, not
        // the window, is what stops it sending twice.
        const s = istSlotState(new Date("2026-09-23T14:00:00Z"), SLOT);
        expect(s.istDate).toBe("2026-09-23");
        expect(s.due).toBe(true);
    });

    it("rolls the date at IST midnight, not UTC midnight", () => {
        // 00:05 IST on the 24th — this instant is still 2026-09-23 in UTC, and
        // treating it as such would re-send the 23rd's card five minutes into
        // the 24th, then never send the 24th's.
        const s = istSlotState(new Date("2026-09-23T18:35:00Z"), SLOT);
        expect(s.istDate).toBe("2026-09-24");
        expect(s.due).toBe(false);
    });

    it("treats a UTC evening instant as the NEXT IST day", () => {
        // 23:00 UTC on the 22nd = 04:30 IST on the 23rd.
        const s = istSlotState(new Date("2026-09-22T23:00:00Z"), SLOT);
        expect(s.istDate).toBe("2026-09-23");
        expect(s.due).toBe(false);
    });

    it("honours a slot with minutes", () => {
        const slot = { hour: 8, minute: 30 };
        // 08:29 IST
        expect(istSlotState(new Date("2026-09-23T02:59:00Z"), slot).due).toBe(false);
        // 08:30 IST
        expect(istSlotState(new Date("2026-09-23T03:00:00Z"), slot).due).toBe(true);
    });

    it("reports the IST wall clock it judged by", () => {
        const s = istSlotState(new Date("2026-09-23T02:30:00Z"), SLOT);
        expect(s.istMinutes).toBe(8 * 60);
    });
});
