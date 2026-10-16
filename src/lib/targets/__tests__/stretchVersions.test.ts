import { describe, expect, it } from "vitest";

import {
    ceoEditLands,
    clockAfterPush,
    CORRECTION_REMARK_MIN,
    NOT_MEASURED,
    postLands,
    progress,
    stretchEditLands,
    targetPeriodLabel,
    targetSumLabel,
    targetToDateLabel,
    validateCorrectionRemark,
    validateOptionalRemark,
    validateStretch,
} from "../rules";

describe("ID 189 — stretch, versions, ask for correction", () => {
    it("the stretch adds on top and never reduces", () => {
        expect(validateStretch(50)).toBeNull();
        expect(validateStretch(0)).toBeNull();
        expect(validateStretch(-20)).toMatch(/never reduce/);
        expect(validateStretch(Number.NaN)).not.toBeNull();
    });

    it("a CEO edit after Post is a draft revision; before Post it changes the draft", () => {
        expect(ceoEditLands("draft")).toBe("in_place");
        for (const s of ["pending_approval", "pushed", "accepted", "rejected"]) expect(ceoEditLands(s)).toBe("draft_revision");
    });

    it("a stretch change waits for the push once the member has the target", () => {
        expect(stretchEditLands("pending_approval")).toBe("in_place");
        for (const s of ["pushed", "accepted", "rejected"]) expect(stretchEditLands(s)).toBe("next");
    });

    it("Post: first post, replace a not-yet-sent target, or wait for the push", () => {
        expect(postLands("draft")).toBe("first_post");
        expect(postLands("pending_approval")).toBe("in_place");
        expect(postLands("pushed")).toBe("next");
        expect(postLands("accepted")).toBe("next");
    });

    it("the 48-hour clock starts at the first push and a correction never restarts it", () => {
        expect(clockAfterPush("pending_approval", null)).toBe("start");
        // pushed → member asked for a correction → pushed again: same clock.
        expect(clockAfterPush("pushed", "2026-10-01T05:00:00Z")).toBe("keep");
        expect(clockAfterPush("rejected", "2026-10-01T05:00:00Z")).toBe("keep");
        // a new version of a target the member had accepted is a new ask.
        expect(clockAfterPush("accepted", "2026-10-01T05:00:00Z")).toBe("start");
    });

    it("a correction needs a remark; accept's remark is optional", () => {
        expect(validateCorrectionRemark("")).not.toBeNull();
        expect(validateCorrectionRemark("x".repeat(CORRECTION_REMARK_MIN))).toBeNull();
        expect(validateOptionalRemark(null)).toBeNull();
        expect(validateOptionalRemark("")).toBeNull();
        expect(validateOptionalRemark("x".repeat(1001))).not.toBeNull();
    });

    it("labels: per day / per month, the sum, working days counted", () => {
        expect(targetPeriodLabel("per_day")).toBe("per day");
        expect(targetPeriodLabel("count")).toBe("per month");
        expect(targetPeriodLabel("money")).toBe("per month");
        expect(targetSumLabel(100, 50)).toBe("CEO 100 + 50 = 150");
        expect(targetSumLabel(100, 0)).toBe("CEO 100");
        expect(targetSumLabel(1000, 500, (n) => `₹${n}`)).toBe("CEO ₹1000 + ₹500 = ₹1500");
        expect(targetToDateLabel(12, 26)).toBe("Target to date (12 of 26 working days)");
    });

    it("not measured carries its reason; a measured actual has none", () => {
        const none = progress({ metric: "kyc_disbursed", monthly: 10, actual: null, reason: NOT_MEASURED.kyc_disbursed, workingDaysTotal: 26, workingDaysElapsed: 13 });
        expect(none.actual).toBeNull();
        expect(none.not_measured_reason).toBe(NOT_MEASURED.kyc_disbursed);
        const fallback = progress({ metric: "dealer_visits", monthly: 10, actual: null, workingDaysTotal: 26, workingDaysElapsed: 13 });
        expect(fallback.not_measured_reason).toBeTruthy();
        const ok = progress({ metric: "dealer_visits", monthly: 26, actual: 0, workingDaysTotal: 26, workingDaysElapsed: 13 });
        expect(ok.actual).toBe(0);
        expect(ok.not_measured_reason).toBeNull();
        expect(ok.pct_of_mtd).toBe(0);
    });
});
