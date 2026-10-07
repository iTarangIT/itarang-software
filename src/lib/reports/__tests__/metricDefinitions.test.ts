import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
    NEODOVE_CALL_MERGE_WINDOW,
    connectedCall,
    engagedCall,
    engagedState,
    humanCall,
    isFirstQuote,
    wasHotAt,
} from "../metricDefinitions";
import { isEngagedCall, shouldAutoEngage } from "@/lib/lifecycle/touchpointTypes";

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

// Decided 3 Oct 2026: engaged = a connected human call where the rep spoke
// with the dealer. No duration, no temperature, no setting.
describe("engagedCall (ID 59)", () => {
    const { text, params } = render(engagedCall());

    it("is exactly a connected human call, counted once", () => {
        expect(text).toBe(render(connectedCall()).text);
        expect(render(engagedCall(sql`tp`)).text).toBe(render(connectedCall(sql`tp`)).text);
    });

    it("never looks at a duration, a temperature or a settings row", () => {
        expect(text).not.toContain("call_duration_sec");
        expect(text).not.toContain("interest_level");
        expect(text).not.toContain("app_settings");
        expect(params).toEqual([]);
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

describe("engagedState (ID 59)", () => {
    const { text, params } = render(engagedState());

    it("a call is engaged exactly when it connected; every other type keeps its stored flag", () => {
        expect(text).toContain("WHEN t.touchpoint_type <> 'inside_sales_call' THEN t.is_engaged");
        expect(text).toContain("ELSE t.call_status IS NOT DISTINCT FROM 'connected'");
        expect(text).not.toContain("call_duration_sec");
        expect(text).not.toContain("app_settings");
        expect(params).toEqual([]);
    });

    // The stored flag (writers) and the SQL (readers) are the same rule.
    it("isEngagedCall / shouldAutoEngage are the TypeScript twin", () => {
        expect(isEngagedCall({ callStatus: "connected" })).toBe(true);
        expect(isEngagedCall({ callStatus: "not_reachable" })).toBe(false);
        expect(isEngagedCall({ callStatus: null })).toBe(false);
        expect(shouldAutoEngage("inside_sales_call", { callStatus: "connected" })).toBe(true);
        expect(shouldAutoEngage("inside_sales_call", { callStatus: "not_responding" })).toBe(false);
        expect(shouldAutoEngage("visit", { visitOutcome: "productive" })).toBe(true);
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
