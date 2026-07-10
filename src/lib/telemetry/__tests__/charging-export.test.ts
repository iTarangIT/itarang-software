import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
    buildChargingAnalysisWorkbook,
    cycleSheetName,
    formatDuration,
    formatIst,
    groupSamplesByCycle,
} from "@/lib/telemetry/charging-export";
import type {
    ChargingCycleAggregate,
    ChargingSample,
} from "@/lib/telemetry/queries";

function sample(overrides: Partial<ChargingSample>): ChargingSample {
    return {
        time: new Date("2026-03-01T00:00:00Z"),
        soc_pct: 20,
        pack_current: 20,
        pack_voltage: 51.2,
        dsoc: 1,
        dt_s: 3600,
        in_sess: 1,
        break_id: 3,
        in_valid_cycle: true,
        ...overrides,
    };
}

// Cycle A clears the 50% gate; cycle B does not, so its capacity stays blank.
const CYCLE_A: ChargingCycleAggregate = {
    break_id: 3,
    start_time: new Date("2026-03-01T00:00:00Z"),
    end_time: new Date("2026-03-01T02:00:00Z"),
    duration_s: 7200,
    ah_charged: 78.2,
    start_soc: 18,
    end_soc: 94,
    soc_measured: 74,
    estimated_capacity_ah: 105.7,
};

const CYCLE_B: ChargingCycleAggregate = {
    break_id: 7,
    start_time: new Date("2026-03-05T10:00:00Z"),
    end_time: new Date("2026-03-05T11:00:00Z"),
    duration_s: 3600,
    ah_charged: 49.1,
    start_soc: 41,
    end_soc: 88,
    soc_measured: 47,
    estimated_capacity_ah: null,
};

const SAMPLES: ChargingSample[] = [
    // Not charging — precedes cycle A.
    sample({ time: new Date("2026-02-28T23:00:00Z"), in_sess: 0, break_id: 2, in_valid_cycle: false, dsoc: -3 }),
    // Cycle A.
    sample({ time: new Date("2026-03-01T00:00:00Z"), soc_pct: 18, dsoc: 2, break_id: 3 }),
    sample({ time: new Date("2026-03-01T01:00:00Z"), soc_pct: 56, dsoc: 38, break_id: 3 }),
    sample({ time: new Date("2026-03-01T02:00:00Z"), soc_pct: 94, dsoc: 38, break_id: 3 }),
    // Charging, but its run was rejected by the >= 5% swing filter.
    sample({ time: new Date("2026-03-03T08:00:00Z"), in_sess: 1, break_id: 5, in_valid_cycle: false, dsoc: 1 }),
    // Cycle B.
    sample({ time: new Date("2026-03-05T10:00:00Z"), soc_pct: 41, dsoc: 3, break_id: 7 }),
    sample({ time: new Date("2026-03-05T11:00:00Z"), soc_pct: 88, dsoc: 47, break_id: 7, pack_current: null }),
];

async function buildAndLoad() {
    const buffer = await buildChargingAnalysisWorkbook({
        vehicleno: "BAT-1001",
        periodLabel: "March 2026",
        generatedAt: new Date("2026-03-31T12:00:00Z"),
        cycles: [CYCLE_A, CYCLE_B],
        samples: SAMPLES,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    return { buffer, workbook };
}

describe("formatIst", () => {
    it("renders UTC instants in IST (+05:30)", () => {
        expect(formatIst(new Date("2026-03-01T00:00:00Z"))).toBe("2026-03-01 05:30:00");
    });

    it("uses a 24-hour clock across midnight IST", () => {
        expect(formatIst(new Date("2026-03-01T18:30:00Z"))).toBe("2026-03-02 00:00:00");
    });

    it("returns an empty string for missing or invalid values", () => {
        expect(formatIst(null)).toBe("");
        expect(formatIst(new Date("nonsense"))).toBe("");
    });
});

describe("formatDuration", () => {
    it("formats seconds, minutes and hours", () => {
        expect(formatDuration(38)).toBe("38s");
        expect(formatDuration(47 * 60)).toBe("47m");
        expect(formatDuration(2 * 3600 + 5 * 60)).toBe("2h 05m");
    });
});

describe("cycleSheetName", () => {
    it("zero-pads to two digits", () => {
        expect(cycleSheetName(1)).toBe("Cycle-01");
        expect(cycleSheetName(12)).toBe("Cycle-12");
    });
});

describe("groupSamplesByCycle", () => {
    it("keeps only samples belonging to a surviving cycle", () => {
        const grouped = groupSamplesByCycle(SAMPLES);
        expect([...grouped.keys()].sort((a, b) => a - b)).toEqual([3, 7]);
        expect(grouped.get(3)).toHaveLength(3);
        expect(grouped.get(7)).toHaveLength(2);
    });

    it("excludes a charging run that the >= 5% swing filter rejected", () => {
        expect(groupSamplesByCycle(SAMPLES).has(5)).toBe(false);
    });
});

describe("buildChargingAnalysisWorkbook", () => {
    it("produces a readable workbook with summary, per-cycle and master sheets", async () => {
        const { workbook } = await buildAndLoad();
        expect(workbook.worksheets.map((w) => w.name)).toEqual([
            "Summary",
            "Cycle-01",
            "Cycle-02",
            "Master Raw Data",
        ]);
    });

    it("writes one summary row per cycle, with both SOC columns", async () => {
        const { workbook } = await buildAndLoad();
        const summary = workbook.getWorksheet("Summary")!;

        // Header sits at row 6, beneath the title block.
        expect(summary.getRow(6).getCell(1).value).toBe("Charging Cycle No.");
        expect(summary.getRow(6).getCell(6).value).toBe("SOC Gain (%)");
        expect(summary.getRow(6).getCell(7).value).toBe("SOC Measured (%)");

        const first = summary.getRow(7);
        expect(first.getCell(1).value).toBe("Cycle-01");
        expect(first.getCell(4).value).toBe(18); // start SOC
        expect(first.getCell(5).value).toBe(94); // end SOC
        expect(first.getCell(6).value).toBe(76); // gain = end - start
        expect(first.getCell(7).value).toBe(74); // measured (current-covered)
        expect(first.getCell(8).value).toBe("2h 00m");
        expect(first.getCell(9).value).toBe(78.2);
        expect(first.getCell(10).value).toBe(105.7);
    });

    it("leaves capacity blank when SOC Measured is below 50", async () => {
        const { workbook } = await buildAndLoad();
        const second = workbook.getWorksheet("Summary")!.getRow(8);
        expect(second.getCell(1).value).toBe("Cycle-02");
        expect(second.getCell(7).value).toBe(47);
        expect(second.getCell(9).value).toBe(49.1);
        // Blank, not zero — we decline to estimate rather than guess.
        expect(second.getCell(10).value ?? null).toBeNull();
    });

    it("accumulates running AH down a cycle sheet", async () => {
        const { workbook } = await buildAndLoad();
        const sheet = workbook.getWorksheet("Cycle-01")!;
        expect(sheet.getRow(1).getCell(7).value).toBe("Running AH");
        // Three samples, each 20 A over 3600 s → 20 Ah per step.
        expect(sheet.getRow(2).getCell(7).value).toBe(20);
        expect(sheet.getRow(3).getCell(7).value).toBe(40);
        expect(sheet.getRow(4).getCell(7).value).toBe(60);
    });

    it("takes cycle-sheet footer totals from the aggregate, not the running sum", async () => {
        const { workbook } = await buildAndLoad();
        const sheet = workbook.getWorksheet("Cycle-01")!;
        // Rows 2-4 are samples, 5 is the spacer, so the footer starts at row 6.
        const labels = new Map<string, ExcelJS.CellValue>();
        for (let r = 6; r <= 10; r++) {
            labels.set(String(sheet.getRow(r).getCell(1).value), sheet.getRow(r).getCell(2).value);
        }
        expect(labels.get("Total Charging Duration")).toBe("2h 00m");
        // 78.2 from SQL, deliberately NOT the 60 Ah the display rows sum to.
        expect(labels.get("Total AH")).toBe(78.2);
        expect(labels.get("SOC Increase")).toBe(76);
        expect(labels.get("Extrapolated Battery Capacity")).toBe(105.7);
    });

    it("explains a blank capacity on the cycle sheet rather than showing zero", async () => {
        const { workbook } = await buildAndLoad();
        const sheet = workbook.getWorksheet("Cycle-02")!;
        const labels = new Map<string, ExcelJS.CellValue>();
        for (let r = 5; r <= 9; r++) {
            labels.set(String(sheet.getRow(r).getCell(1).value), sheet.getRow(r).getCell(2).value);
        }
        expect(labels.get("Extrapolated Battery Capacity")).toBe("N/A (SOC Measured < 50%)");
    });

    it("lists every sample on the master sheet, tagging only those in a surviving cycle", async () => {
        const { workbook } = await buildAndLoad();
        const master = workbook.getWorksheet("Master Raw Data")!;

        const rows = SAMPLES.map((_, i) => master.getRow(i + 2));
        expect(rows).toHaveLength(SAMPLES.length);

        // Non-charging sample: no cycle, status says so.
        expect(rows[0].getCell(2).value ?? "").toBe("");
        expect(rows[0].getCell(7).value).toBe("Not Charging");

        // Cycle A samples carry the sheet name they feed.
        expect(rows[1].getCell(2).value).toBe("Cycle-01");
        expect(rows[1].getCell(3).value).toBe("BAT-1001");
        expect(rows[1].getCell(7).value).toBe("Charging");

        // Charging, but its run was rejected: status "Charging", no cycle ID.
        expect(rows[4].getCell(7).value).toBe("Charging");
        expect(rows[4].getCell(2).value ?? "").toBe("");

        expect(rows[5].getCell(2).value).toBe("Cycle-02");
    });

    it("keeps column widths on the summary sheet, whose title rows commit first", async () => {
        // WorksheetWriter emits <cols> when the first row commits, so widths must be
        // set before the title block. Regression guard: they were silently dropped.
        const { workbook } = await buildAndLoad();
        const summary = workbook.getWorksheet("Summary")!;
        expect(summary.getColumn(1).width).toBe(18);
        expect(summary.getColumn(10).width).toBe(34);

        const master = workbook.getWorksheet("Master Raw Data")!;
        expect(master.getColumn(1).width).toBe(21);
    });

    it("carries the battery, period and timezone note on the summary sheet", async () => {
        const { workbook } = await buildAndLoad();
        const summary = workbook.getWorksheet("Summary")!;
        expect(String(summary.getRow(2).getCell(1).value)).toContain("BAT-1001");
        expect(String(summary.getRow(3).getCell(1).value)).toContain("March 2026");
        expect(String(summary.getRow(4).getCell(1).value)).toContain("Asia/Kolkata");
    });
});
