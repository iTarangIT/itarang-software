// Tests for the dealer account bucket rule (review R-18, metric M28, #5).

import { describe, expect, it } from "vitest";
import {
    accountBucket,
    effectiveDaysSinceOrder,
    ORDER_CLAIM_WINDOW_DAYS,
    orderClaimStatus,
} from "@/lib/dealers/accountHealthRules";

describe("accountBucket", () => {
    it("buckets ordering dealers by days since the last invoice", () => {
        expect(accountBucket(0, 100)).toBe("active");
        expect(accountBucket(20, 100)).toBe("active");
        expect(accountBucket(21, 100)).toBe("cooling");
        expect(accountBucket(30, 100)).toBe("cooling");
        expect(accountBucket(31, 100)).toBe("orange");
        expect(accountBucket(45, 100)).toBe("orange");
        expect(accountBucket(46, 100)).toBe("red");
        expect(accountBucket(60, 100)).toBe("red");
        expect(accountBucket(61, 100)).toBe("dormant");
    });

    it("splits never-ordered dealers at 30 days since conversion", () => {
        expect(accountBucket(null, 0)).toBe("not_ordered_yet");
        expect(accountBucket(null, 30)).toBe("not_ordered_yet");
        expect(accountBucket(null, 31)).toBe("never_ordered");
    });

    it("ID 5: a closed dealer is Closed whatever its order history, never Dormant", () => {
        expect(accountBucket(400, 500, true)).toBe("closed");
        expect(accountBucket(null, 500, true)).toBe("closed");
        expect(accountBucket(5, 100, true)).toBe("closed");
        expect(accountBucket(400, 500, false)).toBe("dormant");
    });
});

describe("ID 5 — Order placed claims (E-334)", () => {
    it("decides a claim's status: withdrawn, then invoiced, then the 15-day window", () => {
        expect(orderClaimStatus({ withdrawn: true, invoiced: true, daysSinceOrder: 3 })).toBe("withdrawn");
        expect(orderClaimStatus({ withdrawn: false, invoiced: true, daysSinceOrder: 40 })).toBe("confirmed");
        expect(orderClaimStatus({ withdrawn: false, invoiced: false, daysSinceOrder: 0 })).toBe("pending");
        expect(orderClaimStatus({ withdrawn: false, invoiced: false, daysSinceOrder: ORDER_CLAIM_WINDOW_DAYS })).toBe("pending");
        expect(orderClaimStatus({ withdrawn: false, invoiced: false, daysSinceOrder: ORDER_CLAIM_WINDOW_DAYS + 1 })).toBe("unconfirmed");
    });

    it("a pending claim pauses ageing; the more recent of claim and invoice wins", () => {
        expect(effectiveDaysSinceOrder(40, null)).toBe(40);
        expect(effectiveDaysSinceOrder(40, 5)).toBe(5);
        expect(effectiveDaysSinceOrder(2, 5)).toBe(2);
        expect(effectiveDaysSinceOrder(null, 5)).toBe(5);
        expect(effectiveDaysSinceOrder(null, null)).toBeNull();
        // An Orange dealer with a fresh claim reads Active, not Orange.
        expect(accountBucket(effectiveDaysSinceOrder(38, 1), 400)).toBe("active");
        // A never-ordered dealer with a claim is no longer "never ordered".
        expect(accountBucket(effectiveDaysSinceOrder(null, 3), 90)).toBe("active");
    });
});
