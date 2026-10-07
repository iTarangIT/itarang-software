// Tests for the dead-number rule (tracker ID 36.1): one dead-number outcome is
// enough from a person, the AI dialer needs two since the last connected call.

import { describe, expect, it } from "vitest";
import {
    contactabilityAction,
    deadNumberReason,
    isAiDeadNumber,
} from "@/lib/leads/deadNumber";

const at = (day: number) => new Date(Date.UTC(2026, 8, day, 6, 0, 0));
const ai = (day: number, status = "incorrect_number") => ({
    touchpoint_type: "ai_call",
    performed_at: at(day),
    call_status: status,
});
const human = (day: number, status: string) => ({
    touchpoint_type: "inside_sales_call",
    performed_at: at(day),
    call_status: status,
});

const DEAD = "Incorrect / Invalid number";

describe("isAiDeadNumber", () => {
    it("one AI incorrect-number call is not enough", () => {
        expect(isAiDeadNumber([ai(1)])).toBe(false);
    });

    it("two AI incorrect-number calls flag it", () => {
        expect(isAiDeadNumber([ai(1), ai(3)])).toBe(true);
    });

    it("only counts calls since the last connected call", () => {
        expect(isAiDeadNumber([ai(1), ai(2, "connected"), ai(3)])).toBe(false);
        expect(isAiDeadNumber([ai(1), human(2, "connected"), ai(3)])).toBe(false);
        expect(isAiDeadNumber([ai(1), human(2, "connected"), ai(3), ai(4)])).toBe(true);
    });

    it("ignores a person's incorrect-number calls and other AI outcomes", () => {
        expect(isAiDeadNumber([ai(1), human(2, "incorrect_number")])).toBe(false);
        expect(isAiDeadNumber([ai(1), ai(2, "not_responding")])).toBe(false);
    });
});

describe("contactabilityAction", () => {
    it("1 AI dead-number call → not flagged (falls back to the non-responsive check)", () => {
        expect(
            contactabilityAction({ connected: false, reasonLabel: DEAD, source: "ai", aiDeadNumber: isAiDeadNumber([ai(1)]) }),
        ).toBe("non_responsive");
    });

    it("2 AI dead-number calls → dead_number", () => {
        expect(
            contactabilityAction({
                connected: false,
                reasonLabel: DEAD,
                source: "ai",
                aiDeadNumber: isAiDeadNumber([ai(1), ai(2)]),
            }),
        ).toBe("dead_number");
    });

    it("1 human dead-number call → dead_number", () => {
        expect(contactabilityAction({ connected: false, reasonLabel: DEAD, source: "human" })).toBe("dead_number");
        // No source = a person (CRM form, NeoDove, Assistant callers).
        expect(contactabilityAction({ connected: false, reasonLabel: DEAD })).toBe("dead_number");
        expect(
            contactabilityAction({
                connected: false,
                reasonLabel: "Number not in use / does not exist / out of service",
            }),
        ).toBe("dead_number");
    });

    it("a connected call clears, whoever made it", () => {
        expect(contactabilityAction({ connected: true, reasonLabel: DEAD, source: "ai" })).toBe("clear");
        expect(contactabilityAction({ connected: true, reasonLabel: null })).toBe("clear");
    });

    it("any other outcome goes to the non-responsive check", () => {
        expect(contactabilityAction({ connected: false, reasonLabel: "Did not pick" })).toBe("non_responsive");
        expect(contactabilityAction({ connected: false, reasonLabel: null, source: "ai" })).toBe("non_responsive");
    });
});

describe("deadNumberReason", () => {
    it("says it took 2 AI calls", () => {
        expect(deadNumberReason(DEAD, "ai")).toBe("2 AI calls: Incorrect / Invalid number");
        expect(deadNumberReason(DEAD)).toBe(DEAD);
    });
});
