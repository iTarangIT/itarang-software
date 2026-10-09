import { describe, expect, it } from "vitest";

import { AGENT_QUESTION_MAX, stripMetricRules, withMetricRules } from "../metricRules";
import { ANALYST_METRIC_RULES } from "@/lib/reports/metricDefinitions";

const Q = "How many dealers converted last month?";

describe("withMetricRules", () => {
    it("adds the rules after the question and stays inside the agent's limit", () => {
        const sent = withMetricRules(Q);
        expect(sent.startsWith(Q)).toBe(true);
        expect(sent).toContain(ANALYST_METRIC_RULES);
        expect(sent.length).toBeLessThanOrEqual(AGENT_QUESTION_MAX);
    });

    it("leaves room for a real question (the rules are short)", () => {
        expect(withMetricRules("x".repeat(1000))).toContain(ANALYST_METRIC_RULES);
    });

    it("sends a long question as asked rather than cut", () => {
        const long = "y".repeat(1900);
        expect(withMetricRules(long)).toBe(long);
    });

    it("carries the agreed Leads-in rule (bulk imports apart)", () => {
        expect(ANALYST_METRIC_RULES).toMatch(/EXCLUDING bulk imports/);
        expect(ANALYST_METRIC_RULES).toMatch(/inside_sales_call/);
    });
});

describe("stripMetricRules", () => {
    it("gives back the user's own question", () => {
        expect(stripMetricRules(withMetricRules(Q))).toBe(Q);
        expect(stripMetricRules(Q)).toBe(Q);
    });

    it("cleans a thread title cut part-way into the rules", () => {
        const sent = withMetricRules(Q);
        expect(stripMetricRules(sent.slice(0, Q.length + 12))).toBe(Q);
        expect(stripMetricRules(sent.slice(0, Q.length + 12) + "…")).toBe(Q);
    });
});
