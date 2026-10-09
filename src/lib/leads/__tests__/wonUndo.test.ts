import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { checkWonUndo } = await import("../wonUndo");

const draft = { status: "draft", submittedAt: null, documents: 0 };

describe("Undo Mark Won (ID 134)", () => {
    it("returns the lead to the exact stage before Won", () => {
        expect(checkWonUndo({ leadStatus: "Won", wonFrom: "Awaiting_Customer_Decision", application: draft })).toEqual({
            ok: true,
            restoreStatus: "Awaiting_Customer_Decision",
        });
        expect(checkWonUndo({ leadStatus: "Won", wonFrom: "Transferred_to_ASM", application: null })).toEqual({
            ok: true,
            restoreStatus: "Transferred_to_ASM",
        });
    });

    it("only a Won lead", () => {
        for (const s of ["Converted", "Lost", "Under_Discussion", null]) {
            expect(checkWonUndo({ leadStatus: s, wonFrom: "Under_Discussion", application: draft }).ok, String(s)).toBe(false);
        }
    });

    it("only before the dealer submits onboarding", () => {
        expect(checkWonUndo({ leadStatus: "Won", wonFrom: "Under_Discussion", application: { ...draft, status: "submitted" } }).ok).toBe(false);
        expect(checkWonUndo({ leadStatus: "Won", wonFrom: "Under_Discussion", application: { ...draft, submittedAt: "2026-10-01" } }).ok).toBe(false);
        expect(checkWonUndo({ leadStatus: "Won", wonFrom: "Under_Discussion", application: { ...draft, documents: 2 } }).ok).toBe(false);
    });

    it("refuses when the earlier stage is not on record", () => {
        expect(checkWonUndo({ leadStatus: "Won", wonFrom: undefined, application: draft }).ok).toBe(false);
        expect(checkWonUndo({ leadStatus: "Won", wonFrom: null, application: draft }).ok).toBe(false);
        expect(checkWonUndo({ leadStatus: "Won", wonFrom: "Lost", application: draft }).ok).toBe(false);
    });
});
