import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
    ENGAGED_CALL_MIN_SECONDS,
    NEODOVE_CALL_MERGE_WINDOW,
    connectedCall,
    engagedCall,
    engagedCallCount,
    engagedState,
    humanCall,
    isFirstQuote,
    measuredCall,
    timedCall,
    wasHotAt,
} from "../metricDefinitions";
import {
    DEFAULT_ENGAGED_CALL_RULE,
    isEngagedCall,
    isTimedCall,
    normalizeEngagedCallRule,
    type EngagedCallRule,
} from "@/lib/lifecycle/touchpointTypes";

// The definitions are SQL fragments; what can be pinned without a database is
// their shape. The numbers are checked against a live database by
// scripts/verify-p0-wave1.ts.
const render = (q: ReturnType<typeof sql>) => {
    const out = new PgDialect().sqlToQuery(q);
    return { text: out.sql.replace(/\s+/g, " "), params: out.params };
};

describe("humanCall (ID 59)", () => {
    const { text } = render(humanCall());

    it("counts inside-sales calls only — never the AI dialer's", () => {
        expect(text).toContain("t.touchpoint_type = 'inside_sales_call'");
        expect(text).not.toContain("ai_call");
    });

    it("drops a NeoDove re-disposition of a call already counted", () => {
        expect(text).toContain("t.external_system = 'neodove'");
        expect(text).toContain("prev.dealer_lead_id = t.dealer_lead_id");
        expect(text).toContain("prev.performed_by IS NOT DISTINCT FROM t.performed_by");
        expect(text).toContain(`INTERVAL '${NEODOVE_CALL_MERGE_WINDOW}'`);
        expect(NEODOVE_CALL_MERGE_WINDOW).toBe("3 minutes");
    });

    it("uses the alias it is given", () => {
        const aliased = render(humanCall(sql`tp`)).text;
        expect(aliased).toContain("tp.touchpoint_type = 'inside_sales_call'");
        expect(aliased).not.toMatch(/\bt\.touchpoint_type/);
    });
});

describe("engagedCall (ID 59)", () => {
    const { text } = render(engagedCall());

    it("is a human call, connected, for at least the threshold (30 s unless the setting says otherwise)", () => {
        expect(text).toContain(render(humanCall()).text);
        expect(text).toContain("t.call_status = 'connected'");
        expect(text).toContain("COALESCE(t.call_duration_sec, 0) >=");
        expect(ENGAGED_CALL_MIN_SECONDS).toBe(30);
        expect(render(engagedCall(sql`t`, DEFAULT_ENGAGED_CALL_RULE)).params).toContain(30);
    });

    // humanCall keeps the EARLIEST row of a NeoDove call; the connect and the
    // duration can sit on a later re-disposition of the same call.
    it("also counts the kept row when a later NeoDove twin qualifies", () => {
        expect(text).toContain("twin.dealer_lead_id = t.dealer_lead_id");
        expect(text).toContain("twin.performed_by IS NOT DISTINCT FROM t.performed_by");
        expect(text).toContain("twin.performed_at >= t.performed_at");
        expect(text).toContain("twin.call_status = 'connected'");
        expect(text).toContain("COALESCE(twin.call_duration_sec, 0) >=");
    });

    it("stays one row per call: the twin test is ANDed with humanCall, never ORed around it", () => {
        const human = render(humanCall()).text;
        expect(text.startsWith(human)).toBe(true);
        expect(text.slice(human.length).trimStart().startsWith("AND (")).toBe(true);
    });
});

describe("connectedCall (ID 59)", () => {
    const { text } = render(connectedCall());

    it("is a human call, counted once, that connected — on its own row or a later NeoDove twin", () => {
        const human = render(humanCall()).text;
        expect(text.startsWith(human)).toBe(true);
        expect(text.slice(human.length).trimStart().startsWith("AND (")).toBe(true);
        expect(text).toContain("t.call_status = 'connected' OR (");
        expect(text).toContain("twin.performed_at >= t.performed_at");
        expect(text).toContain("twin.call_status = 'connected'");
        expect(text).not.toContain("call_duration_sec");
    });
});

// Review 30 Sep, point 1: the duration must be NeoDove's, not one a rep typed.
// The rule (threshold + whose duration counts) is a setting; an explicit rule
// here stands in for what the settings row would say.
describe("engaged = measured duration (ID 59)", () => {
    const NEODOVE: EngagedCallRule = { minSeconds: 30, durationSource: "neodove" };
    const REPORTED: EngagedCallRule = { minSeconds: 30, durationSource: "reported" };

    it("the default is 30 s of NeoDove-recorded duration; anything unrecognised falls back to it", () => {
        expect(DEFAULT_ENGAGED_CALL_RULE).toEqual(NEODOVE);
        expect(normalizeEngagedCallRule(null)).toEqual(NEODOVE);
        expect(normalizeEngagedCallRule({ min_seconds: "abc", duration_source: "anything" })).toEqual(NEODOVE);
        expect(normalizeEngagedCallRule({ min_seconds: 2 })).toEqual(NEODOVE);
        expect(normalizeEngagedCallRule({ min_seconds: 9999 })).toEqual(NEODOVE);
        expect(normalizeEngagedCallRule({ min_seconds: 45, duration_source: "reported" })).toEqual({
            minSeconds: 45,
            durationSource: "reported",
        });
    });

    it("timedCall / measuredCall say which durations are measurements", () => {
        expect(render(timedCall(sql`t`, NEODOVE)).text).toBe("t.call_duration_sec IS NOT NULL AND (t.external_system = 'neodove' OR FALSE)");
        expect(render(timedCall(sql`t`, REPORTED)).text).toBe("t.call_duration_sec IS NOT NULL AND (t.external_system = 'neodove' OR TRUE)");
        expect(render(measuredCall(sql`t`, NEODOVE)).text).toBe(
            "t.touchpoint_type = 'inside_sales_call' AND t.call_duration_sec IS NOT NULL AND (t.external_system = 'neodove' OR FALSE)",
        );
    });

    it("the direct branch of engagedCall needs a measured duration of at least the threshold", () => {
        const { text, params } = render(engagedCall(sql`t`, { minSeconds: 45, durationSource: "neodove" }));
        expect(text).toContain(
            "t.call_status = 'connected' AND t.call_duration_sec IS NOT NULL AND (t.external_system = 'neodove' OR FALSE) AND COALESCE(t.call_duration_sec, 0) >=",
        );
        expect(params).toEqual([45, 45]); // the row's own duration, and the later twin's
    });

    it("with no rule given, the fragment reads the saved setting itself — with the same default and bounds", () => {
        const { text, params } = render(engagedCall());
        expect(text).toContain("FROM app_settings ecr WHERE ecr.key = 'engaged_call_rule'");
        expect(text).toContain("ecr.value ->> 'duration_source' = 'reported'");
        expect(text).toContain("ecr.value ->> 'min_seconds' ~ '^[0-9]{1,4}$'");
        expect(text).toContain("BETWEEN 5 AND 600");
        expect(text).toContain("END END FROM app_settings ecr WHERE ecr.key = 'engaged_call_rule'), 30)");
        expect(text).toContain("), FALSE)");
        expect(params).toEqual([]); // nothing bound: the rule is entirely the row's
    });

    it("engagedCallCount is NULL — not 0 — when nothing in the set was measured", () => {
        const { text } = render(engagedCallCount(sql`t`, NEODOVE));
        expect(text.startsWith("CASE WHEN COUNT(*) FILTER (WHERE t.touchpoint_type = 'inside_sales_call' AND t.call_duration_sec IS NOT NULL AND (t.external_system = 'neodove' OR FALSE)) = 0 THEN NULL")).toBe(true);
        expect(text).toContain(`ELSE COUNT(*) FILTER (WHERE ${render(engagedCall(sql`t`, NEODOVE)).text}) END`);
    });

    it("engagedState: a call follows the rule, every other type keeps its stored flag", () => {
        const { text, params } = render(engagedState(sql`t`, NEODOVE));
        expect(text).toContain("WHEN t.touchpoint_type <> 'inside_sales_call' THEN t.is_engaged");
        expect(text).toContain("WHEN t.call_status IS DISTINCT FROM 'connected' THEN FALSE");
        expect(text).toContain("WHEN t.call_duration_sec IS NOT NULL AND (t.external_system = 'neodove' OR FALSE) THEN t.call_duration_sec >=");
        expect(text).toContain("ELSE NULL");
        expect(params).toEqual([30]);
    });

    // The stored flag (writers) and the SQL (readers) are the same rule.
    it("isEngagedCall is the TypeScript twin", () => {
        const neodove = { callStatus: "connected", durationSec: 45, externalSystem: "neodove" };
        const typed = { callStatus: "connected", durationSec: 45, externalSystem: null };
        expect(isEngagedCall(neodove)).toBe(true);
        expect(isEngagedCall({ ...neodove, durationSec: 29 })).toBe(false);
        expect(isEngagedCall({ ...neodove, durationSec: null })).toBe(false);
        expect(isEngagedCall({ ...neodove, callStatus: "not_reachable" })).toBe(false);
        expect(isEngagedCall(neodove, { minSeconds: 60, durationSource: "neodove" })).toBe(false);
        expect(isEngagedCall(typed, NEODOVE)).toBe(false);
        expect(isEngagedCall(typed, REPORTED)).toBe(true);
        expect(isTimedCall(typed, NEODOVE)).toBe(false);
        expect(isTimedCall({ durationSec: 0, externalSystem: "neodove" }, NEODOVE)).toBe(true);
    });
});

describe("wasHotAt (ID 59)", () => {
    const { text } = render(wasHotAt(sql`dl.id`, sql`t.performed_at`, sql`dl.interest_level`));

    it("reads the rating AT the transfer from the interest history, falling back to the current one", () => {
        expect(text).toContain("FROM dealer_lead_interest_history h");
        expect(text).toContain("h.changed_at <= t.performed_at");
        expect(text).toContain("h.changed_at > t.performed_at");
        expect(text).toContain("ELSE dl.interest_level");
        expect(text.trim().endsWith("= 'hot'")).toBe(true);
    });
});

describe("isFirstQuote (ID 59)", () => {
    const { text } = render(isFirstQuote());

    it("is the lowest-version quote of its lead; revisions are everything else", () => {
        expect(text).toContain("earlier.dealer_lead_id = c.dealer_lead_id");
        expect(text).toContain("earlier.event_type IN ('quote_issue', 'quote_revision')");
        expect(text).toContain("earlier.version_no < c.version_no");
        expect(text.trim().startsWith("NOT EXISTS")).toBe(true);
    });
});
