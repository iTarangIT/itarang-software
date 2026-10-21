import { describe, expect, it } from "vitest";

import {
    AGENT_QUESTION_MAX,
    ANALYST_QUESTION_MAX,
    questionTopics,
    RULES_ROOM_AT_MAX,
    stripMetricRules,
    withMetricRules,
} from "../metricRules";
import { ANALYST_METRIC_RULES, ANALYST_RULES } from "@/lib/reports/metricDefinitions";

const rule = (re: RegExp) => ANALYST_RULES.find((r) => re.test(r.text))!.text;

const Q = "How many dealers converted last month?";

describe("withMetricRules", () => {
    it("adds the rules after the question and stays inside the agent's limit", () => {
        const sent = withMetricRules(Q);
        expect(sent.startsWith(Q)).toBe(true);
        expect(sent).toContain(rule(/^Dealers converted/));
        expect(sent).toContain(rule(/^Days, yesterday/));
        expect(sent.length).toBeLessThanOrEqual(AGENT_QUESTION_MAX);
    });

    it("routes rules by topic (ID 32): revenue by salesperson gets revenue + people rules", () => {
        const q = "What was revenue by salesperson last month?";
        expect(questionTopics(q)).toEqual(expect.arrayContaining(["revenue", "people"]));
        const sent = withMetricRules(q);
        expect(sent).toContain(rule(/^Revenue = /));
        expect(sent).toContain(rule(/^A salesperson's revenue/));
        expect(sent).not.toContain(rule(/^Gross margin/));
    });

    it("carries the money rules the dashboards use (void, credit notes, batteries, margin, Won vs Converted)", () => {
        expect(ANALYST_METRIC_RULES).toMatch(/invoice_voids/);
        expect(ANALYST_METRIC_RULES).toMatch(/credit_notes/);
        expect(ANALYST_METRIC_RULES).toMatch(/product_class 'battery'/);
        expect(ANALYST_METRIC_RULES).toMatch(/not costed/);
        expect(ANALYST_METRIC_RULES).toMatch(/targets, credit and incentives use Converted/);
        expect(withMetricRules("How many batteries did we sell in September?")).toContain(rule(/^Batteries sold/));
        expect(withMetricRules("Gross margin % last quarter?")).toContain(rule(/^Gross margin/));
    });

    it("a long question still carries its rules — never sent bare (ID 32)", () => {
        const long = "How much revenue did we book? " + "x".repeat(ANALYST_QUESTION_MAX - 31);
        expect(long.length).toBeLessThanOrEqual(ANALYST_QUESTION_MAX);
        const sent = withMetricRules(long);
        expect(sent.length).toBeLessThanOrEqual(AGENT_QUESTION_MAX);
        expect(sent).toContain(rule(/^Days, yesterday/));
        expect(sent).toContain(rule(/^Revenue = /));
    });

    it("the question cap leaves room for the always-on rules and the biggest topic rule", () => {
        const always = ANALYST_RULES.filter((r) => r.topics.length === 0).map((r) => r.text).join(" ");
        const biggest = Math.max(...ANALYST_RULES.map((r) => r.text.length));
        expect(RULES_ROOM_AT_MAX(ANALYST_QUESTION_MAX)).toBeGreaterThanOrEqual(always.length + 1 + biggest);
    });

    it("a question with no topic gets every rule that fits", () => {
        const sent = withMetricRules("Summarise yesterday");
        expect(sent).toContain(rule(/^Leads in/));
        expect(sent.length).toBeLessThanOrEqual(AGENT_QUESTION_MAX);
    });

    it("carries the agreed Leads-in rule (every source, ID 153)", () => {
        expect(ANALYST_METRIC_RULES).toMatch(/bulk imports included/);
        expect(ANALYST_METRIC_RULES).not.toMatch(/EXCLUDING bulk/);
        expect(ANALYST_METRIC_RULES).toMatch(/inside_sales_call/);
    });

    it("tells the analyst Finance is retired (ID 11)", () => {
        expect(ANALYST_METRIC_RULES).toMatch(/'finance' means battery_sale/);
    });

    it("topic words match whole words (the \\b escapes are real word boundaries, not backspaces)", () => {
        expect(questionTopics("How many leads came in last week?")).toContain("leads");
        expect(questionTopics("Calls made yesterday")).toContain("calls");
        expect(questionTopics("Which dealers did we lose? Lost count please")).toContain("won");
        expect(questionTopics("Units sold by SKU")).toContain("batteries");
        expect(questionTopics("What did the batteries cost us?")).toContain("margin");
        expect(questionTopics("Which reps did best?")).toContain("people");
        expect(questionTopics("Have you already counted it?")).not.toContain("leads");
    });

    it("Visits carry Fresh, Repeat and New to iTarang, on visited rows only (ID 185)", () => {
        const visits = rule(/^Visits = /);
        expect(visits).toMatch(/visit_status 'visited'/);
        expect(visits).toMatch(/Fresh = the rep's first visited visit/);
        expect(visits).toMatch(/Repeat = Visits - Fresh/);
        expect(visits).toMatch(/New to iTarang = the dealer's first visited visit by anyone/);
        expect(withMetricRules("Fresh vs repeat visits by ASM last month")).toContain(visits);
    });

    it("an idle question gets the idle rule and its per-holder limits (ID 192)", () => {
        const idle = rule(/^Idle = /);
        expect(idle).toMatch(/GREATEST\(last_worked_at, assigned_at, next_follow_up_at if within 30 days ahead\), created_at\)/);
        expect(idle).toMatch(/idle_asm \(default 7\)/);
        expect(idle).toMatch(/idle_cc \(default 5\)/);
        expect(idle).toMatch(/holiday_calendar/);
        expect(withMetricRules("Which leads are idle past the limit?")).toContain(idle);
    });

    it("ready leads with no owner: the awaitingAssignment rule, split AI-qualified first (ID 184)", () => {
        const ready = rule(/^Ready leads with no owner/);
        expect(ready).toMatch(/sales_ready_at set, current_owner_id NULL/);
        expect(ready).toMatch(/contactability NULL/);
        expect(ready.indexOf("ai_qualified")).toBeLessThan(ready.indexOf("'hot'"));
        expect(withMetricRules("How many ready leads have no owner?")).toContain(ready);
    });

    it("live dealers leave out closed accounts; GSTIN missing from the flags view (ID 148)", () => {
        const live = rule(/^Live dealers/);
        expect(live).toMatch(/account_closures/);
        expect(live).toMatch(/gstin_missing/);
        expect(questionTopics("How many live dealers have no GSTIN?")).toContain("accounts");
        expect(withMetricRules("How many live dealers have no GSTIN?")).toContain(live);
    });

    it("gross margin reads the product stamped on the line, not a join on item name (ID 147)", () => {
        const margin = rule(/^Gross margin/);
        expect(margin).toMatch(/invoice_line_items\.amount_excl_gst/);
        expect(margin).toMatch(/product_id \/ asset_type/);
        expect(margin).toMatch(/never join vyapar_item_map by item name/);
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
