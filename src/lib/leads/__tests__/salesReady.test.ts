import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint: vi.fn() }));
const {
    AWAITING_ASSIGNMENT_OVERDUE_DAYS,
    awaitingAssignment,
    awaitingSince,
    createdByHandReason,
    daysAwaitingAssignment,
    salesReadyReasonLabel,
    SALES_READY_REASONS,
} = await import("../salesReady");

const render = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ");

// Tracker ID 82, review 30 Sep point 1: the CEO card counted dead numbers and
// the list did not. Both — and the daily email — now read this one rule.
describe("awaitingAssignment (ID 82)", () => {
    const text = render(awaitingAssignment());

    it("is a sales-ready, open lead nobody owns", () => {
        expect(text).toContain("dl.current_owner_id IS NULL");
        expect(text).toContain("dl.is_active IS NOT FALSE");
        expect(text).toContain("COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')");
        expect(text).toContain("(to_jsonb(dl) ->> 'sales_ready_at') IS NOT NULL");
    });

    it("never counts a dead or non-responsive number", () => {
        expect(text).toContain("(to_jsonb(dl) ->> 'contactability') IS NULL");
    });

    it("reads the E-314 columns through to_jsonb, so a database without them answers 'nobody' instead of failing", () => {
        expect(text).not.toMatch(/dl\.sales_ready_at|dl\.contactability/);
    });

    it("uses the alias it is given", () => {
        const aliased = render(awaitingAssignment(sql`x`));
        expect(aliased).toContain("x.current_owner_id IS NULL");
        expect(aliased).not.toMatch(/\bdl\./);
    });

    it("the wait is counted from the Sales-ready event, never from creation", () => {
        const wait = render(daysAwaitingAssignment());
        expect(wait).toContain("(to_jsonb(dl) ->> 'sales_ready_at')::timestamptz");
        expect(wait).not.toContain("created_at");
        expect(AWAITING_ASSIGNMENT_OVERDUE_DAYS).toBe(7);
    });

    // A Lost lead reactivated with nobody to return to goes back to the pool
    // with its ORIGINAL Sales-ready date; it has been waiting since it came back.
    it("a lead that went back to the pool waits from that moment, not from its first Sales-ready date", () => {
        const since = render(awaitingSince());
        expect(since.startsWith("GREATEST(")).toBe(true);
        expect(since).toContain("FROM dealer_lead_status_history h");
        expect(since).toContain("h.dealer_lead_id = dl.id AND h.to_status = 'New_Unassigned'");
        expect(render(daysAwaitingAssignment())).toContain(since);
    });
});

describe("Sales-ready reasons", () => {
    it("every reason has a plain label; an unknown one is shown readably", () => {
        for (const r of SALES_READY_REASONS) expect(salesReadyReasonLabel(r)).not.toContain("_");
        expect(salesReadyReasonLabel("admin_assigned")).toBe("assigned by an admin");
        expect(salesReadyReasonLabel("admin_marked")).toBe("marked qualified by a reviewer");
        expect(salesReadyReasonLabel("reactivated")).toBe("reactivated into the sales pool");
        expect(salesReadyReasonLabel("some_new_reason")).toBe("some new reason");
        expect(salesReadyReasonLabel(null)).toBe("");
    });

    it("a hand-created lead the dealer called in about is an inbound inquiry; any other is rep-created", () => {
        expect(createdByHandReason("inbound_call")).toBe("inbound_inquiry");
        expect(createdByHandReason("field_walk_in")).toBe("rep_created");
        expect(createdByHandReason(null)).toBe("rep_created");
        expect(createdByHandReason(undefined)).toBe("rep_created");
    });
});
