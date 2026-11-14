// IDs 245 / 237 / 247: when a visit happened, and the lead's one open booking.
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { nextBookingJoin, overdueDays, REMARK_TOUCHPOINT_TYPES } from "@/lib/asm/nextBooking";
import { visitTime, visitTimeSql, visitWhenTextSql } from "@/lib/visits/visitTime";
import { dateOnlyWords, isDateOnly } from "@/lib/visits/visitTimeText";

const dialect = new PgDialect();

describe("visitTime (245)", () => {
    it("photo time first", () => {
        expect(visitTime({ captured_at: "2026-09-29T09:57:00Z", created_at: "2026-09-29T12:00:00Z", actual_visit_date: "2026-09-29" })).toEqual({
            at: "2026-09-29T09:57:00.000Z",
            hasTime: true,
        });
    });
    it("else the time it was logged, when logged the same IST day", () => {
        // Devendra pal: sales-ready 3:24 pm, visited 3:27 pm IST (09:57 UTC).
        expect(visitTime({ created_at: "2026-09-29T09:57:00Z", actual_visit_date: "2026-09-29" }).at).toBe("2026-09-29T09:57:00.000Z");
    });
    it("else 10:00 IST on the visit day, marked as no real time", () => {
        expect(visitTime({ created_at: "2026-10-02T09:00:00Z", actual_visit_date: "2026-09-29" })).toEqual({
            at: "2026-09-29T04:30:00.000Z",
            hasTime: false,
        });
    });
    it("the SQL reads captured_at through to_jsonb and keeps the 10:00 fallback", () => {
        const q = dialect.sqlToQuery(visitTimeSql("v")).sql;
        expect(q).toMatch(/to_jsonb\(v\) ->> 'captured_at'/);
        expect(q).toMatch(/TIME '10:00'/);
    });
});

describe("visit 'when' in the Sales Head pop-ups (237)", () => {
    it("photo time as an instant, else the bare date", () => {
        const q = dialect.sqlToQuery(visitWhenTextSql("v")).sql;
        expect(q).toMatch(/to_char\(/);
        expect(q).toMatch(/v\.actual_visit_date::text/);
    });
    it("a bare date reads as the date with 'no time recorded'", () => {
        expect(isDateOnly("2026-11-03")).toBe(true);
        expect(isDateOnly("2026-11-03T09:57:00Z")).toBe(false);
        expect(dateOnlyWords("2026-11-03")).toBe("3 Nov 2026 · no time recorded");
    });
});

describe("the one open booking (247)", () => {
    it("is the newest open booking, overdue included", () => {
        const q = dialect.sqlToQuery(nextBookingJoin("nb")).sql;
        expect(q).toMatch(/visit_status IN \('scheduled', 'pending_scheduling'\)/);
        expect(q).toMatch(/ORDER BY b\.created_at DESC/);
        expect(q).not.toMatch(/scheduled_date >=/);
    });
    it("overdue days in IST", () => {
        // Adnan: booked for 3 Nov; on 12 Nov it is 9 days overdue.
        expect(overdueDays("2026-11-03", "2026-11-12")).toBe(9);
        expect(overdueDays("2026-11-12", "2026-11-12")).toBeNull();
        expect(overdueDays("2026-12-03", "2026-11-12")).toBeNull();
        expect(overdueDays(null, "2026-11-12")).toBeNull();
    });
    it("latest remarks skip re-inquiry, sales-ready, corrections and assignment lines (224)", () => {
        for (const t of ["lead_reinquiry", "sales_ready", "record_correction", "lead_assigned", "lead_created"]) {
            expect(REMARK_TOUCHPOINT_TYPES as readonly string[]).not.toContain(t);
        }
        expect(REMARK_TOUCHPOINT_TYPES).toContain("visit");
        expect(REMARK_TOUCHPOINT_TYPES).toContain("inside_sales_call");
    });
});
