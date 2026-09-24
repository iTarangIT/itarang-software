import { describe, expect, it, vi } from "vitest";

// recordVisit.ts imports the Drizzle client, which throws at import without
// DATABASE_URL. planVisit is pure; nothing here touches the database.
vi.mock("@/lib/db", () => ({ db: {} }));

const { planVisit } = await import("../recordVisit");

const base = {
    leadId: "DL-1",
    asmId: "asm-1",
    visit_status: "visited" as const,
    visit_outcome: "productive" as const,
    visit_remarks: "owner Ramesh, needs 10 batteries",
    next_action: "next_visit" as const,
    next_visit_date: "2026-09-26",
};

describe("planVisit (extracted from POST /api/asm/lead/[id]/visit)", () => {
    it("a visited row with no date is dated today", () => {
        const { visitRow } = planVisit(base, "2026-09-24");
        expect(visitRow.actual_visit_date).toBe("2026-09-24");
        expect(visitRow.visit_status).toBe("visited");
        expect(visitRow.next_visit_date).toBe("2026-09-26");
    });

    it("an explicit actual date wins; a non-visited row gets no date", () => {
        expect(planVisit({ ...base, actual_visit_date: "2026-09-20" }, "2026-09-24").visitRow.actual_visit_date).toBe("2026-09-20");
        expect(planVisit({ ...base, visit_status: "postponed" }, "2026-09-24").visitRow.actual_visit_date).toBeNull();
    });

    it("the touchpoint mirrors the route: engaged outcome, remarks, next action", () => {
        const { touchpoint } = planVisit(base, "2026-09-24");
        expect(touchpoint).toMatchObject({
            dealerLeadId: "DL-1",
            touchpointType: "visit",
            performedBy: "asm-1",
            isEngaged: true,
            remarks: "visited · productive\n\nowner Ramesh, needs 10 batteries\n\nNext visit: 2026-09-26",
            nextAction: "follow_up",
        });
        expect(touchpoint.nextActionAt?.toISOString()).toBe("2026-09-26T00:00:00.000Z");
    });

    it("non-engaged outcomes and other next actions map as before", () => {
        const t = planVisit(
            { ...base, visit_outcome: "dealer_not_present", next_action: "lost", next_visit_date: null },
            "2026-09-24",
        ).touchpoint;
        expect(t.isEngaged).toBe(false);
        expect(t.nextAction).toBe("mark_lost");
        expect(t.remarks).toBe("visited · dealer_not_present\n\nowner Ramesh, needs 10 batteries");
        expect(planVisit({ ...base, next_action: "convert" }, "x").touchpoint.nextAction).toBe("mark_converted");
        expect(planVisit({ ...base, next_action: "escalate" }, "x").touchpoint.nextAction).toBeNull();
    });

    it("photos become touchpoint attachments; GPS is stringified", () => {
        const { visitRow, touchpoint } = planVisit(
            { ...base, photos: ["/api/files/a.jpg"], gps_check_in_lat: 19.07, gps_check_in_lng: 72.87 },
            "2026-09-24",
        );
        expect(touchpoint.attachments).toEqual([{ url: "/api/files/a.jpg", type: "photo" }]);
        expect(visitRow.gps_check_in_lat).toBe("19.07");
    });
});

describe("planVisit → scheduled next visit (CRM fix, BRD §2.3-2)", () => {
    it("next_visit schedules a row for that date", () => {
        expect(planVisit(base, "2026-09-24").scheduled).toEqual({
            leadId: "DL-1",
            asmId: "asm-1",
            date: "2026-09-26",
            remarks: "Next visit, scheduled from the visit on 2026-09-24",
        });
    });

    it("other next actions schedule nothing", () => {
        for (const next_action of ["convert", "lost", "escalate"] as const) {
            expect(planVisit({ ...base, next_action }, "2026-09-24").scheduled).toBeNull();
        }
    });

    it("schedules only strictly after the visit date (a same-day tie breaks the latest-visit lateral)", () => {
        expect(planVisit({ ...base, next_visit_date: "2026-09-23" }, "2026-09-24").scheduled).toBeNull();
        expect(planVisit({ ...base, next_visit_date: "2026-09-24" }, "2026-09-24").scheduled).toBeNull();
        // A visit logged for last week can schedule today.
        expect(
            planVisit({ ...base, actual_visit_date: "2026-09-17", next_visit_date: "2026-09-20" }, "2026-09-24").scheduled?.date,
        ).toBe("2026-09-20");
    });
});
