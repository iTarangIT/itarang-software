import { describe, expect, it } from "vitest";

import { onboardingStall, onboardingWaitingOn, STALL_LABEL } from "../stall";

// Thursday 1 Oct 2026, noon UTC.
const NOW = new Date("2026-10-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("onboardingWaitingOn", () => {
    it("draft and correction requested wait on the dealer", () => {
        expect(onboardingWaitingOn({ onboarding_status: "draft", agreement_status: "not_generated" })).toBe("dealer");
        expect(onboardingWaitingOn({ onboarding_status: "correction_requested", agreement_status: null })).toBe("dealer");
    });
    it("a submitted application with an unsigned agreement waits on the dealer", () => {
        for (const a of ["sent_for_signature", "partially_signed", "requested"]) {
            expect(onboardingWaitingOn({ onboarding_status: "submitted", agreement_status: a }), a).toBe("dealer");
        }
    });
    it("a submitted application otherwise waits on us", () => {
        for (const a of [null, "not_generated", "completed", "expired", "failed"]) {
            expect(onboardingWaitingOn({ onboarding_status: "submitted", agreement_status: a }), String(a)).toBe("us");
        }
    });
    it("closed onboardings wait on nobody", () => {
        for (const s of ["approved", "rejected", "withdrawn", null]) {
            expect(onboardingWaitingOn({ onboarding_status: s, agreement_status: null }), String(s)).toBeNull();
        }
    });
});

describe("onboardingStall", () => {
    const dealer = { onboarding_status: "draft", agreement_status: "not_generated" };
    const us = { onboarding_status: "submitted", agreement_status: "not_generated" };

    it("dealer side stalls at 7 calendar days", () => {
        expect(onboardingStall({ ...dealer, last_activity_at: daysAgo(6.9) }, new Set(), NOW)).toBeNull();
        expect(onboardingStall({ ...dealer, last_activity_at: daysAgo(7) }, new Set(), NOW)).toBe("dealer");
    });
    it("our side stalls at 2 working days", () => {
        // Tue 29 Sep → Thu 1 Oct = 2 working days.
        expect(onboardingStall({ ...us, last_activity_at: "2026-09-29T10:00:00Z" }, new Set(), NOW)).toBe("us");
        // Wed 30 Sep → 1 working day.
        expect(onboardingStall({ ...us, last_activity_at: "2026-09-30T10:00:00Z" }, new Set(), NOW)).toBeNull();
    });
    it("a Sunday and a holiday do not count", () => {
        // Sat 26 Sep → Tue 29 Sep: Sun skipped, Mon a holiday → only Tue counts.
        const now = new Date("2026-09-29T12:00:00Z");
        expect(onboardingStall({ ...us, last_activity_at: "2026-09-26T10:00:00Z" }, new Set(["2026-09-28"]), now)).toBeNull();
        expect(onboardingStall({ ...us, last_activity_at: "2026-09-26T10:00:00Z" }, new Set(), now)).toBe("us");
    });
    it("no activity timestamp or a closed onboarding is never stalled", () => {
        expect(onboardingStall({ ...us, last_activity_at: null }, new Set(), NOW)).toBeNull();
        expect(onboardingStall({ onboarding_status: "approved", agreement_status: "completed", last_activity_at: daysAgo(90) }, new Set(), NOW)).toBeNull();
    });
    it("labels", () => {
        expect(STALL_LABEL.dealer).toBe("Stalled · waiting on dealer");
        expect(STALL_LABEL.us).toBe("Stalled · waiting on us");
    });
});
