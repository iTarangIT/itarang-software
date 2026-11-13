import { describe, expect, it } from "vitest";

import {
    AGENT_INSTRUCTIONS_MAX,
    AGENT_QUESTION_MAX,
    ANALYST_QUESTION_MAX,
    cleanRun,
    cleanThread,
    INSTRUCTIONS_HEAD,
    LEGACY_RULES_MARK,
    metricInstructions,
    questionTopics,
    stripMetricRules,
} from "../metricRules";
import { ANALYST_METRIC_RULES, ANALYST_RULES } from "@/lib/reports/metricDefinitions";

const rule = (re: RegExp) => ANALYST_RULES.find((r) => re.test(r.text))!.text;

const Q = "How many dealers converted last month?";

describe("metricInstructions", () => {
    it("carries the rules apart from the question, inside the agent's instructions limit (13 Nov)", () => {
        const sent = metricInstructions(Q);
        expect(sent.startsWith(INSTRUCTIONS_HEAD)).toBe(true);
        expect(sent).not.toContain(Q);
        expect(sent).toContain(rule(/^Dealers converted/));
        expect(sent).toContain(rule(/^Days, yesterday/));
        expect(sent.length).toBeLessThanOrEqual(AGENT_INSTRUCTIONS_MAX);
    });

    it("every rule fits at once, so none is ever dropped for room", () => {
        const all = metricInstructions("Summarise yesterday");
        for (const r of ANALYST_RULES) expect(all).toContain(r.text);
        expect(all.length).toBeLessThanOrEqual(AGENT_INSTRUCTIONS_MAX);
    });

    it("a question gets the agent's whole question limit", () => {
        expect(ANALYST_QUESTION_MAX).toBe(AGENT_QUESTION_MAX);
    });

    it("every answer states its period, defaults to today (IST), and counts in business units", () => {
        const sent = metricInstructions(Q);
        expect(sent).toMatch(/No date or period in the question means today \(IST\)/);
        expect(sent).toMatch(/Open every answer with the period counted/);
        expect(sent).toMatch(/never as rows, records or entries/);
    });

    it("a named person is matched in analyst_staff, given by full name, never answered 0 when unmatched", () => {
        const staff = rule(/^A person named in the question/);
        expect(staff).toMatch(/analyst_staff/);
        expect(staff).toMatch(/matched full name/);
        expect(staff).toMatch(/never answer 0 for a name that matched nobody/);
        expect(staff).toMatch(/lead_visits\.asm_id = analyst_staff\.user_id/);
        expect(metricInstructions("How many visits did Biplabh Ghosh do this month?")).toContain(staff);
    });

    it("routes rules by topic (ID 32): revenue by salesperson gets revenue + people rules", () => {
        const q = "What was revenue by salesperson last month?";
        expect(questionTopics(q)).toEqual(expect.arrayContaining(["revenue", "people"]));
        const sent = metricInstructions(q);
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
        expect(metricInstructions("How many batteries did we sell in September?")).toContain(rule(/^Batteries sold/));
        expect(metricInstructions("Gross margin % last quarter?")).toContain(rule(/^Gross margin/));
    });

    it("a question as long as allowed still carries its rules — never sent bare (ID 32)", () => {
        const long = "How much revenue did we book? " + "x".repeat(ANALYST_QUESTION_MAX - 31);
        expect(long.length).toBeLessThanOrEqual(ANALYST_QUESTION_MAX);
        const sent = metricInstructions(long);
        expect(sent).toContain(rule(/^Days, yesterday/));
        expect(sent).toContain(rule(/^Revenue = /));
    });

    it("a question with no topic gets every rule", () => {
        expect(metricInstructions("Summarise yesterday")).toContain(rule(/^Leads in/));
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
        expect(metricInstructions("Fresh vs repeat visits by ASM last month")).toContain(visits);
    });

    it("an idle question gets the idle rule and its per-holder limits (ID 192)", () => {
        const idle = rule(/^Idle = /);
        expect(idle).toMatch(/GREATEST\(last_worked_at, assigned_at, next_follow_up_at if within 30 days ahead\), created_at\)/);
        expect(idle).toMatch(/idle_asm \(default 7\)/);
        expect(idle).toMatch(/idle_cc \(default 5\)/);
        expect(idle).toMatch(/holiday_calendar/);
        expect(metricInstructions("Which leads are idle past the limit?")).toContain(idle);
    });

    it("ready leads with no owner: the awaitingAssignment rule, split Hot first (ID 184)", () => {
        const ready = rule(/^Ready leads with no owner/);
        expect(ready).toMatch(/sales_ready_at set, current_owner_id NULL/);
        expect(ready).toMatch(/contactability NULL/);
        expect(ready.indexOf("'hot'")).toBeLessThan(ready.indexOf("ai_qualified"));
        expect(metricInstructions("How many ready leads have no owner?")).toContain(ready);
    });

    it("live dealers leave out closed accounts; GSTIN missing from the flags view (ID 148)", () => {
        const live = rule(/^Live dealers/);
        expect(live).toMatch(/account_closures/);
        expect(live).toMatch(/gstin_missing/);
        expect(questionTopics("How many live dealers have no GSTIN?")).toContain("accounts");
        expect(metricInstructions("How many live dealers have no GSTIN?")).toContain(live);
    });

    it("gross margin reads the product stamped on the line, not a join on item name (ID 147)", () => {
        const margin = rule(/^Gross margin/);
        expect(margin).toMatch(/invoice_line_items\.amount_excl_gst/);
        expect(margin).toMatch(/product_id \/ asset_type/);
        expect(margin).toMatch(/never join vyapar_item_map by item name/);
    });
});

describe("stripMetricRules (runs asked before 13 Nov)", () => {
    // How a question was stored when the rules rode glued to it.
    const legacy = Q + LEGACY_RULES_MARK + rule(/^Days, yesterday/);

    it("gives back the user's own question", () => {
        expect(stripMetricRules(legacy)).toBe(Q);
        expect(stripMetricRules(Q)).toBe(Q);
    });

    it("cleans a thread title cut part-way into the rules", () => {
        expect(stripMetricRules(legacy.slice(0, Q.length + 12))).toBe(Q);
        expect(stripMetricRules(legacy.slice(0, Q.length + 12) + "…")).toBe(Q);
    });

    it("a reopened conversation's runs and titles come back clean (13 Nov)", () => {
        expect(cleanRun({ id: "r1", question: legacy }).question).toBe(Q);
        expect(cleanThread({ thread_id: "t1", title: legacy.slice(0, 120) + "…" }).title).toBe(Q);
    });
});
