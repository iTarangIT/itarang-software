import { describe, expect, it } from "vitest";
import {
    creditNoteAppliedFor,
    invoiceSeries,
    isOlderExport,
    lastPaymentDateFor,
    paymentChangeFor,
    registerPaidFor,
    totalsDisagree,
} from "@/lib/sales/registerPaymentRules";

describe("Vyapar payment sync rules", () => {
    it("the register's received figure, capped to the invoice and never negative", () => {
        expect(registerPaidFor(300000, 353705)).toBe(300000);
        expect(registerPaidFor(400000, 353705)).toBe(353705); // overpayment is a credit, not this invoice
        expect(registerPaidFor(-5, 1000)).toBe(0);
        expect(registerPaidFor(null, 1000)).toBeNull();
        expect(registerPaidFor(undefined, 1000)).toBeNull();
        expect(registerPaidFor(10.005, 100)).toBe(10.01);
    });

    it("absolute figures: the same file twice is no change; a reversal comes back down", () => {
        expect(paymentChangeFor(300000, 300000)).toBe("none");
        expect(paymentChangeFor(300000, 300000.004)).toBe("none");
        expect(paymentChangeFor(0, 10000)).toBe("increase");
        expect(paymentChangeFor(60000, 10000)).toBe("decrease");
        expect(paymentChangeFor(5000, null)).toBe("no_data");
    });

    it("₹10,000 → ₹60,000 → full: each upload moves the invoice to Vyapar's total so far", () => {
        const total = 100000;
        let paid = 0;
        for (const received of [10000, 60000, 100000]) {
            const after = registerPaidFor(received, total)!;
            expect(paymentChangeFor(paid, after)).toBe("increase");
            paid = after;
        }
        expect(total - paid).toBe(0);
        expect(paymentChangeFor(paid, registerPaidFor(100000, total))).toBe("none");
    });

    it("an older export never silently replaces a newer one; unknown stamps never block", () => {
        expect(isOlderExport("2026-10-21T10:00:00+05:30", "2026-10-28T14:24:00+05:30")).toBe(true);
        expect(isOlderExport("2026-10-28T14:24:00+05:30", "2026-10-28T14:24:00+05:30")).toBe(false);
        expect(isOlderExport("2026-11-04T09:00:00+05:30", "2026-10-28T08:54:00.000Z")).toBe(false);
        expect(isOlderExport(null, "2026-10-28T14:24:00+05:30")).toBe(false);
        expect(isOlderExport("2026-10-21T10:00:00+05:30", null)).toBe(false);
    });

    it("a rise is dated to the export; no change keeps the date; nothing paid clears it", () => {
        expect(lastPaymentDateFor("increase", 50000, "2026-10-28T14:24:00+05:30", "2026-10-01", "2026-11-03")).toBe("2026-10-28");
        expect(lastPaymentDateFor("increase", 50000, null, null, "2026-11-03")).toBe("2026-11-03");
        expect(lastPaymentDateFor("decrease", 20000, "2026-10-28T14:24:00+05:30", "2026-10-01", "2026-11-03")).toBe("2026-10-01");
        expect(lastPaymentDateFor("decrease", 0, "2026-10-28T14:24:00+05:30", "2026-10-01", "2026-11-03")).toBeNull();
    });

    it("CRM and Vyapar totals disagree only beyond a rupee", () => {
        expect(totalsDisagree(353705, 353705.4)).toBe(false);
        expect(totalsDisagree(8024000, 23244479.8)).toBe(true);
        expect(totalsDisagree(null, 100)).toBe(false);
    });

    it("a credit note's used part is its total less Vyapar's balance", () => {
        expect(creditNoteAppliedFor(463386, 463386)).toBe(0); // not yet adjusted
        expect(creditNoteAppliedFor(463386, 0)).toBe(463386); // fully adjusted against an invoice
        expect(creditNoteAppliedFor(47775, 7775)).toBe(40000);
        expect(creditNoteAppliedFor(1000, 2000)).toBe(0);
        expect(creditNoteAppliedFor(1000, null)).toBeNull();
    });

    it("an invoice's series is its prefix", () => {
        expect(invoiceSeries("ITG/202627/087")).toBe("ITG");
        expect(invoiceSeries("itd/202627/017")).toBe("ITD");
        expect(invoiceSeries("ICNH-06")).toBe("ICNH");
        expect(invoiceSeries("1")).toBeNull();
    });
});
