// Tests for the dealer account bucket rule (review R-18, metric M28, #5).

import { describe, expect, it } from "vitest";
import { accountBucket } from "@/lib/dealers/accountHealthRules";

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
});
