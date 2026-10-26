import { describe, expect, it } from "vitest";

import { ALL_CLOCK_KINDS } from "../clockRules";
import { CLOCK_GOAL, CLOCK_SHORT, limitPassedWords } from "../limitEventLabels";

// IDs 194 #3 / 188 #5 — the emails printed "Limit passed: quote_deliver" for
// the three clocks added on 18 Oct. Every clock must have words.
describe("clock labels", () => {
    it("every clock kind has a goal and a short name", () => {
        for (const k of ALL_CLOCK_KINDS) {
            expect(CLOCK_GOAL[k], k).toBeTruthy();
            expect(CLOCK_SHORT[k], k).toBeTruthy();
        }
    });
    it("names the newer clocks in words", () => {
        expect(limitPassedWords("quote_deliver")).toBe("approved quote sent to the dealer");
        expect(limitPassedWords("ready_assign")).toBe("sales-ready lead getting an owner");
        expect(limitPassedWords("quote_revise")).toBe("declined quote revised or lead marked Lost");
    });
    it("never prints a raw code", () => {
        expect(limitPassedWords("some_new_clock")).toBe("a time limit");
    });
});
