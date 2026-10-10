import { describe, expect, it } from "vitest";
import { checkReportingLine } from "@/lib/users/reportingCycle";

const lines = (pairs: Array<[string, string | null]>) => new Map(pairs);

describe("checkReportingLine (ID 155)", () => {
    it("clearing a line is always fine", () => {
        expect(checkReportingLine("a", null, lines([["a", "b"]]))).toEqual({ ok: true });
    });

    it("refuses reporting to yourself", () => {
        expect(checkReportingLine("a", "a", lines([]))).toMatchObject({ ok: false, reason: "self" });
    });

    it("two associates under one ASM is fine", () => {
        const m = lines([["sonu", "head"], ["x", "sonu"]]);
        expect(checkReportingLine("y", "sonu", m)).toEqual({ ok: true });
    });

    it("refuses a direct loop A → B → A", () => {
        expect(checkReportingLine("a", "b", lines([["b", "a"]]))).toEqual({ ok: false, reason: "cycle", chain: ["a", "b", "a"] });
    });

    it("refuses a longer loop", () => {
        const m = lines([["c", "b"], ["b", "a"]]);
        expect(checkReportingLine("a", "c", m)).toMatchObject({ ok: false, reason: "cycle" });
    });

    it("does not spin on a loop elsewhere in the data", () => {
        const m = lines([["p", "q"], ["q", "p"]]);
        expect(checkReportingLine("a", "p", m)).toEqual({ ok: true });
    });
});
