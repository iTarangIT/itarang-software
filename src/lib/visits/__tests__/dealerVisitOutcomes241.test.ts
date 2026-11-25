import { describe, expect, it } from "vitest";
import {
    bucketChip,
    dealerNextStep,
    dealerVisitProblem,
    historyMatches,
    leadOutcomeFor,
    sortHistory,
    type DealerFacts,
    type HistoryItem,
} from "../dealerVisitOutcomes";

const today = "2026-11-18";

describe("ID 241-2: dealer visit fields", () => {
    const ok = { dealerOutcome: "order_taken", reportedAmount: 25000, nextVisitDate: "2026-11-25", noFollowUp: false };

    it("accepts an outcome, an amount and a next visit date", () => {
        expect(dealerVisitProblem(ok, today)).toBeNull();
    });
    it("needs an outcome from the dealer list", () => {
        expect(dealerVisitProblem({ ...ok, dealerOutcome: "productive" }, today)).toMatch(/visit outcome/);
    });
    it("needs a next visit date unless No follow-up", () => {
        expect(dealerVisitProblem({ ...ok, nextVisitDate: null }, today)).toMatch(/next visit date/);
        expect(dealerVisitProblem({ ...ok, nextVisitDate: null, noFollowUp: true }, today)).toBeNull();
        expect(dealerVisitProblem({ ...ok, noFollowUp: true }, today)).toMatch(/not both/);
    });
    it("books only after today and within 90 days", () => {
        expect(dealerVisitProblem({ ...ok, nextVisitDate: today }, today)).toMatch(/after today/);
        expect(dealerVisitProblem({ ...ok, nextVisitDate: "2026-11-10" }, today)).toMatch(/after today/);
        expect(dealerVisitProblem({ ...ok, nextVisitDate: "2027-03-01" }, today)).toMatch(/90 days/);
        expect(dealerVisitProblem({ ...ok, nextVisitDate: "25/11/2026" }, today)).toMatch(/valid/);
    });
    it("amount is optional but never negative", () => {
        expect(dealerVisitProblem({ ...ok, reportedAmount: null }, today)).toBeNull();
        expect(dealerVisitProblem({ ...ok, reportedAmount: -5 }, today)).toMatch(/positive/);
    });
    it("maps to the lead outcome the visit numbers count", () => {
        expect(leadOutcomeFor("order_taken")).toBe("productive");
        expect(leadOutcomeFor("dealer_not_present")).toBe("dealer_not_present");
        expect(leadOutcomeFor("other")).toBe("other");
    });
});

describe("ID 241-1: Next step box", () => {
    const base: DealerFacts = {
        bucket: "orange",
        daysSinceLastOrder: 44,
        daysSinceConversion: 51,
        orders: 1,
        nextVisitDate: null,
        pendingOrder: false,
    };
    it("Orange: pitch the next order (mock-up wording)", () => {
        const s = dealerNextStep(base, today);
        expect(s.title).toBe("Pitch the next order: 44 days since the only invoice");
        expect(s.detail).toMatch(/At 46 days it turns Red/);
    });
    it("an overdue booked visit comes first", () => {
        const s = dealerNextStep({ ...base, nextVisitDate: "2026-11-15" }, today);
        expect(s.tone).toBe("red");
        expect(s.title).toMatch(/^Visit was due .*: 3 days overdue$/);
    });
    it("a visit due today", () => {
        expect(dealerNextStep({ ...base, nextVisitDate: today }, today).title).toBe("Visit due today");
    });
    it("never ordered counts from conversion", () => {
        expect(dealerNextStep({ ...base, bucket: "never_ordered", orders: 0, daysSinceLastOrder: null }, today).title).toBe(
            "Get the first order: 51 days since becoming a dealer",
        );
    });
    it("stage chip without the day range", () => {
        expect(bucketChip("orange")).toBe("Orange, pitch now");
        expect(bucketChip("dormant")).toBe("Dormant");
    });
});

describe("ID 241-1: one history", () => {
    const items: HistoryItem[] = [
        { kind: "joined", at: "2026-09-28", title: "Became a dealer", detail: null },
        { kind: "invoice", at: "2026-09-28", title: "Invoice", detail: null },
        { kind: "booked", at: "2026-11-25", title: "Visit booked", detail: null },
        { kind: "visit", at: "2026-11-18T10:00:00+05:30", title: "Visit", detail: null },
        { kind: "quote", at: "2026-10-02T09:00:00Z", title: "Quote", detail: null },
    ];
    it("booked first, then newest first, ties keep their order", () => {
        expect(sortHistory(items).map((i) => i.kind)).toEqual(["booked", "visit", "quote", "joined", "invoice"]);
    });
    it("filters", () => {
        expect(items.filter((i) => historyMatches(i, "visits")).map((i) => i.kind)).toEqual(["booked", "visit"]);
        expect(items.filter((i) => historyMatches(i, "invoices")).map((i) => i.kind)).toEqual(["invoice"]);
        // 25 Nov item 8: recorded orders have their own filter.
        const order: HistoryItem = { kind: "order", at: "2026-10-05", title: "Order recorded", detail: null };
        expect(historyMatches(order, "orders")).toBe(true);
        expect(historyMatches(order, "invoices")).toBe(false);
    });
});
