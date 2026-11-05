// ID 85 (5 Nov) — calling hours: Admin only, and a change can start on a later day.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { dueScheduledHours, effectiveFromError } from "@/lib/ai-dialer/callingHoursRules";

const h = (start: string) => ({ start, end: "19:00", days: null });

describe("effectiveFromError", () => {
    it("today or later is fine; a past day or a bad value is refused", () => {
        expect(effectiveFromError(null, "2026-11-05")).toBeNull();
        expect(effectiveFromError("2026-11-05", "2026-11-05")).toBeNull();
        expect(effectiveFromError("2026-11-10", "2026-11-05")).toBeNull();
        expect(effectiveFromError("2026-11-04", "2026-11-05")).toMatch(/passed/);
        expect(effectiveFromError("10/11/2026", "2026-11-05")).toMatch(/Pick/);
    });
});

describe("dueScheduledHours", () => {
    const rows = [
        { id: "a", effectiveFrom: "2026-11-08", createdAt: "2026-11-05 10:00", hours: h("10:00") },
        { id: "b", effectiveFrom: "2026-11-06", createdAt: "2026-11-05 11:00", hours: h("09:30") },
        { id: "c", effectiveFrom: "2026-11-06", createdAt: "2026-11-05 12:00", hours: h("09:00") },
    ];
    it("nothing before its day", () => {
        expect(dueScheduledHours(rows, "2026-11-05")).toBeNull();
    });
    it("on its day: the latest change made for that day", () => {
        expect(dueScheduledHours(rows, "2026-11-06")?.id).toBe("c");
    });
    it("once a later one is due too, the later start wins", () => {
        expect(dueScheduledHours(rows, "2026-11-09")?.id).toBe("a");
    });
});

describe("who may change the hours", () => {
    it("Admin only, on both save routes", () => {
        // Read as text: callTiming.ts loads the database client.
        expect(readFileSync("src/lib/ai-dialer/callTiming.ts", "utf8")).toMatch(/CALLING_HOURS_EDIT_ROLES = \["admin"\] as const;/);
        const callTiming = readFileSync("src/app/api/campaigns/call-timing/route.ts", "utf8");
        const settings = readFileSync("src/app/api/admin/settings/assignment-config/route.ts", "utf8");
        expect(callTiming).toMatch(/POST = withErrorHandler\(async \(req: Request\) => \{\s*const user = await requireRole\(\[\.\.\.CALLING_HOURS_EDIT_ROLES\]\)/);
        expect(settings).toMatch(/requireRole\(\[\.\.\.CALLING_HOURS_EDIT_ROLES\]\)/);
        expect(settings).not.toMatch(/requireRole\(\["admin", "sales_head"\]\)/);
    });
});
