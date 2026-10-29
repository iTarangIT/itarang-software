import { describe, expect, it, vi } from "vitest";

import { isOverpaid, paymentStatusFor } from "../paymentStatus";

vi.mock("@/lib/db", () => ({ db: {} }));
const { registerCreditNoteKey } = await import("../vyaparImport");

describe("paymentStatusFor (ID 200)", () => {
    it("nothing collected is sent, part is partially paid, all is paid", () => {
        expect(paymentStatusFor(0, 118000)).toBe("sent");
        expect(paymentStatusFor(36000, 236000)).toBe("partially_paid");
        expect(paymentStatusFor(118000, 118000)).toBe("paid");
    });
    it("half a paisa short still counts as paid", () => {
        expect(paymentStatusFor(117999.996, 118000)).toBe("paid");
        expect(paymentStatusFor(117999.99, 118000)).toBe("partially_paid");
    });
    it("an overpayment is refused, not absorbed", () => {
        expect(isOverpaid(118000.01, 118000)).toBe(true);
        expect(isOverpaid(118000.004, 118000)).toBe(false);
    });
});

describe("registerCreditNoteKey (ID 200)", () => {
    it("a series number is keyed like the Drive scan keys it", () => {
        expect(registerCreditNoteKey("ICNH/202627/06", "2026-09-05")).toBe(registerCreditNoteKey(" icnh/202627/06 ", null));
    });
    it("a bare number is kept apart by its date", () => {
        expect(registerCreditNoteKey("1", "2026-09-05")).toBe("VYAPAR-CN-1-2026-09-05");
        expect(registerCreditNoteKey("1", "2027-04-02")).not.toBe(registerCreditNoteKey("1", "2026-09-05"));
    });
});
