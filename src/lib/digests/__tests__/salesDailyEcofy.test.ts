/**
 * ID 51 — Block G of the Daily Sales email: Ecofy pickup queue, new leads
 * yesterday and leads by stage.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { ecofyBlockRows, salesDailyDigest } = await import("../kinds/sales-daily");
const { ECOFY_STAGE_LABELS } = await import("@/lib/ecofy/access");

describe("Block G · Ecofy", () => {
    it("puts the queue and yesterday first, then stages in pipeline order with a total", () => {
        const rows = ecofyBlockRows(
            {
                queue: 3,
                newYesterday: 2,
                byStage: [
                    { stage: "CLOSED", n: 1 },
                    { stage: "S3", n: 4 },
                    { stage: "S1", n: 5 },
                    { stage: null, n: 1 },
                    { stage: "S5", n: 0 },
                ],
            },
            ECOFY_STAGE_LABELS,
        );
        expect(rows).toEqual([
            ["Pickup queue (unassigned)", 3],
            ["New leads yesterday", 2],
            ["BY STAGE", ""],
            ["S1 · Pickup queue", 5],
            ["S3 · Assessment", 4],
            ["CLOSED · Closed", 1],
            ["(no stage)", 1],
            ["All Ecofy leads", 11],
        ]);
    });

    it("has its own section switch", () => {
        expect(salesDailyDigest.sections.map((s) => s.key)).toContain("block_g");
    });
});
