import { beforeEach, describe, expect, it, vi } from "vitest";

// Tracker ID 82 (gap check 01 Oct 2026): a reviewer correcting a lead's AI band
// to qualified is a Sales-ready event, as the AI call's own "qualified" is.
// Without it a human-qualified lead never reached Ready to assign.

const execute = vi.fn(async (): Promise<unknown[]> => [{ id: "DL-1", unowned_open: true }]);
vi.mock("@/lib/db", () => ({ db: { execute } }));
const markSalesReady = vi.fn(async () => true);
vi.mock("@/lib/leads/salesReady", () => ({ markSalesReady }));

const { applyIntentOverride } = await import("../intentOverride");
const REVIEWER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
    execute.mockClear();
    markSalesReady.mockClear();
});

describe("applyIntentOverride → Sales-ready", () => {
    it("a band corrected to qualified records the event, credited to the reviewer", async () => {
        const out = await applyIntentOverride({ leadId: "DL-1", band: "Qualified", reviewerId: REVIEWER });
        expect(out).toMatchObject({ applied: true, status: "qualified" });
        expect(markSalesReady).toHaveBeenCalledTimes(1);
        expect(markSalesReady).toHaveBeenCalledWith(expect.anything(), { leadId: "DL-1", reason: "admin_marked", actorId: REVIEWER });
        expect(execute.mock.invocationCallOrder[0]).toBeLessThan(markSalesReady.mock.invocationCallOrder[0]!);
    });

    it("any other band does not", async () => {
        for (const band of ["Warm", "Cold", "Disqualified"] as const) {
            const out = await applyIntentOverride({ leadId: "DL-1", band, reviewerId: REVIEWER });
            expect(out.status, band).not.toBe("qualified");
        }
        expect(markSalesReady).not.toHaveBeenCalled();
    });

    it("an owned (or closed) lead does not — the correction changes only the AI score (ID 64.2)", async () => {
        execute.mockResolvedValueOnce([{ id: "DL-1", unowned_open: false }]);
        const out = await applyIntentOverride({ leadId: "DL-1", band: "Qualified", reviewerId: REVIEWER });
        expect(out.applied).toBe(true);
        expect(markSalesReady).not.toHaveBeenCalled();
    });

    it("an override that found no lead does not", async () => {
        execute.mockResolvedValueOnce([]);
        const out = await applyIntentOverride({ leadId: "DL-404", band: "Qualified", reviewerId: REVIEWER });
        expect(out.applied).toBe(false);
        expect(markSalesReady).not.toHaveBeenCalled();
    });
});
