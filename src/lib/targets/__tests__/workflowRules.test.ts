import { describe, expect, it } from "vitest";

import {
    CUSTOM_METRIC_PREFIX,
    isCustomMetric,
    metricKind,
    newCustomMetricKey,
    progress,
    REJECT_COMMENT_MIN,
    TARGET_STATUS_LABEL,
    TARGET_STATUSES,
    validateCustomMetric,
    validateRejectComment,
} from "../rules";

describe("item 3 — target workflow rules", () => {
    it("every status has a label, and 'rejected' is one of them", () => {
        expect(TARGET_STATUSES).toContain("rejected");
        for (const s of TARGET_STATUSES) expect(TARGET_STATUS_LABEL[s]).toBeTruthy();
        expect(TARGET_STATUS_LABEL.pending_approval).toMatch(/Sales Head/);
    });

    it("a reject needs a real comment", () => {
        expect(validateRejectComment("")).not.toBeNull();
        expect(validateRejectComment("  no ")).not.toBeNull();
        expect(validateRejectComment("x".repeat(REJECT_COMMENT_MIN))).toBeNull();
        expect(validateRejectComment("Too many calls with my field days")).toBeNull();
        expect(validateRejectComment("x".repeat(1001))).not.toBeNull();
    });

    it("custom metric keys fit varchar(40) and are recognised", () => {
        const k = newCustomMetricKey();
        expect(k.startsWith(CUSTOM_METRIC_PREFIX)).toBe(true);
        expect(k.length).toBeLessThanOrEqual(40);
        expect(isCustomMetric(k)).toBe(true);
        expect(isCustomMetric("dealer_visits")).toBe(false);
    });

    it("a custom metric needs a name; unit is optional and short", () => {
        expect(validateCustomMetric(" ", null)).not.toBeNull();
        expect(validateCustomMetric("Demo rides", null)).toBeNull();
        expect(validateCustomMetric("Demo rides", "x".repeat(21))).not.toBeNull();
    });

    it("kind: built-in from the vocabulary, custom from its unit", () => {
        expect(metricKind("revenue")).toBe("money");
        expect(metricKind("calls_per_day")).toBe("per_day");
        expect(metricKind("custom_ab12cd34", "₹")).toBe("money");
        expect(metricKind("custom_ab12cd34", "Rs.")).toBe("money");
        expect(metricKind("custom_ab12cd34", "shops")).toBe("count");
        expect(metricKind("custom_ab12cd34", null)).toBe("count");
    });

    it("progress works for a custom metric with hand-entered actual", () => {
        const p = progress({ metric: "custom_ab12cd34", kind: "count", monthly: 20, actual: 5, workingDaysTotal: 25, workingDaysElapsed: 10 });
        expect(p.mtd_target).toBe(8);
        expect(p.pct_of_mtd).toBe(63);
        const none = progress({ metric: "custom_ab12cd34", kind: "count", monthly: 20, actual: null, workingDaysTotal: 25, workingDaysElapsed: 10 });
        expect(none.rag).toBeNull();
    });
});
