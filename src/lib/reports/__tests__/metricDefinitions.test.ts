import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
    ENGAGED_CALL_MIN_SECONDS,
    NEODOVE_CALL_MERGE_WINDOW,
    engagedCall,
    humanCall,
    isFirstQuote,
    wasHotAt,
} from "../metricDefinitions";

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
    const { text, params } = render(engagedCall());

    it("is a human call, connected, for at least 30 seconds", () => {
        expect(text).toContain(render(humanCall()).text);
        expect(text).toContain("t.call_status = 'connected'");
        expect(text).toContain("COALESCE(t.call_duration_sec, 0) >=");
        expect(ENGAGED_CALL_MIN_SECONDS).toBe(30);
        expect(params).toContain(30);
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
