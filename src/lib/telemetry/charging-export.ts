/**
 * Charging Analysis workbook builder for /ceo/intellicar → Trip Analytics.
 *
 * Produces the Excel that lets an engineer hand-verify charging-cycle detection,
 * the coulomb-counted AH, and the extrapolated 100% battery capacity.
 *
 * Two rules govern this file:
 *
 *  1. **Cycle numbers come from the aggregate query, never from re-summing the
 *     samples.** Postgres `round(numeric, 2)` is half-away-from-zero while JS
 *     `Math.round` is half-up; `end_time` is the last *rising* sample rather than
 *     the cycle's last row; and `duration_s` deliberately excludes the first
 *     attributed interval. Re-deriving any of these in JS would make the workbook
 *     disagree with the dashboard it exists to check.
 *
 *  2. **The workbook is buffered, not streamed to the client.** We still use
 *     ExcelJS's `WorkbookWriter` — per-row `commit()` serialises cells into the
 *     zip and frees them, so peak memory tracks one sheet rather than the whole
 *     workbook. But its `commit()` only resolves once the destination stream
 *     emits `finish`, which needs a consumer: handing the PassThrough straight
 *     back as the HTTP body either deadlocks or, if commit runs detached, ships a
 *     truncated .xlsx after the 200 and Content-Disposition are already on the
 *     wire. So we drain into memory and send one complete Response.
 */
import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import {
    CAPACITY_SOC_THRESHOLD,
    COVERAGE_TRUST_GAP_S,
    MIN_COVERAGE_PCT,
    MIN_CYCLE_SAMPLES,
    ahIncrement,
} from "./charging-math";
import type { ChargingCycleAggregate, ChargingSample } from "./queries";

/**
 * Caps sized for the 8 GB VPS that runs sandbox and production side by side.
 * The Master Raw Data sheet is the dominant term. Measured on this builder,
 * worst case (every sample inside a cycle, so the rows appear twice):
 *
 *    40k samples →  6.1 s,  +87 MB RSS,  3.4 MB file
 *   100k samples → 15.4 s, +144 MB RSS,  8.3 MB file   ← the cap
 *   200k samples → 21.1 s, +330 MB RSS, 16.7 MB file
 *
 * Per-row commit() keeps memory near-linear, so time and download size bind
 * before memory does. 200k risks an nginx/PM2 proxy timeout; 40k would reject
 * even a one-month window on a fast poller.
 */
export const MAX_SAMPLES = 100_000;
export const MAX_CYCLES = 100;

const HEADER_FILL = "FF1F4E78";
const TZ_NOTE = "All timestamps are IST (Asia/Kolkata).";

const IST_FORMAT = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
});

/** `YYYY-MM-DD HH:mm:ss` in IST. Text, not an Excel date: Excel dates carry no timezone. */
export function formatIst(value: Date | string | null | undefined): string {
    if (value == null) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = Object.fromEntries(
        IST_FORMAT.formatToParts(date).map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Seconds → `2h 05m` / `47m` / `38s`. */
export function formatDuration(seconds: number | null | undefined): string {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total < 60) return `${total}s`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (!hours) return `${minutes}m`;
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** 1 → `Cycle-01`. Excel caps sheet names at 31 chars; these are far shorter. */
export function cycleSheetName(cycleNo: number): string {
    return `Cycle-${String(cycleNo).padStart(2, "0")}`;
}

/** Round for display without pretending to more precision than we have. */
function round(value: number, dp: number): number {
    const f = 10 ** dp;
    return Math.round(value * f) / f;
}

/** Group samples by the cycle they belong to. Non-charging samples are excluded. */
export function groupSamplesByCycle(
    samples: ChargingSample[],
): Map<number, ChargingSample[]> {
    const byBreakId = new Map<number, ChargingSample[]>();
    for (const sample of samples) {
        if (!sample.in_valid_cycle) continue;
        const bucket = byBreakId.get(sample.break_id);
        if (bucket) bucket.push(sample);
        else byBreakId.set(sample.break_id, [sample]);
    }
    return byBreakId;
}

type SheetLike = Pick<ExcelJS.Worksheet, "getRow" | "getColumn">;

/**
 * Must run before the sheet's first row is committed: WorksheetWriter emits the
 * <cols> block when it writes the first row, so widths set afterwards are dropped.
 */
function setWidths(sheet: SheetLike, widths: number[]) {
    widths.forEach((width, i) => {
        sheet.getColumn(i + 1).width = width;
    });
}

function writeHeaderRow(sheet: SheetLike, headers: string[], rowNo = 1) {
    const row = sheet.getRow(rowNo);
    row.values = headers;
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: HEADER_FILL },
    };
    row.commit();
}

export interface ChargingAnalysisInput {
    vehicleno: string;
    /** Human label for the window, e.g. `March 2026` or `Last 3 Months`. */
    periodLabel: string;
    generatedAt: Date;
    /** Authoritative per-cycle numbers, ascending by start_time. */
    cycles: ChargingCycleAggregate[];
    /** Every sample in the window, ascending by time. Display only. */
    samples: ChargingSample[];
}

/**
 * Build the workbook and return the complete .xlsx bytes.
 *
 * Sheet order: `Summary`, then `Cycle-01…Cycle-NN` chronologically, then
 * `Master Raw Data`.
 */
export async function buildChargingAnalysisWorkbook(
    input: ChargingAnalysisInput,
): Promise<Buffer> {
    const { vehicleno, periodLabel, generatedAt, cycles, samples } = input;

    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const drained = new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
    });
    // If commit() rejects we throw before awaiting `drained`; without this, a later
    // stream error would surface as an unhandled rejection.
    drained.catch(() => {});

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream,
        useStyles: true,
        useSharedStrings: true,
    });
    workbook.creator = "iTarang";
    workbook.created = generatedAt;

    // Cycle N ↔ break_id, so the raw sheets can name the cycle each sample fed.
    const cycleNoByBreakId = new Map<number, number>();
    cycles.forEach((cycle, i) => cycleNoByBreakId.set(cycle.break_id, i + 1));
    const samplesByBreakId = groupSamplesByCycle(samples);

    writeSummarySheet(workbook, { vehicleno, periodLabel, generatedAt, cycles });

    cycles.forEach((cycle, i) => {
        writeCycleSheet(
            workbook,
            cycleSheetName(i + 1),
            cycle,
            samplesByBreakId.get(cycle.break_id) ?? [],
        );
    });

    writeMasterSheet(workbook, vehicleno, samples, cycleNoByBreakId);

    await workbook.commit();
    await drained;
    return Buffer.concat(chunks);
}

function writeSummarySheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    opts: {
        vehicleno: string;
        periodLabel: string;
        generatedAt: Date;
        cycles: ChargingCycleAggregate[];
    },
) {
    const { vehicleno, periodLabel, generatedAt, cycles } = opts;
    const HEADER_ROW = 6;
    const sheet = workbook.addWorksheet("Summary", {
        views: [{ state: "frozen", ySplit: HEADER_ROW }],
    });

    // Before any row is committed, or the widths never reach the file: WorksheetWriter
    // emits <cols> when it writes the first row.
    setWidths(sheet, [18, 21, 21, 11, 10, 15, 17, 13, 13, 11, 13, 14, 19, 34, 13, 12]);

    const title = sheet.getRow(1);
    title.values = ["Charging Cycle Summary"];
    title.font = { bold: true, size: 14 };
    title.commit();

    for (const [rowNo, text] of [
        [2, `Battery: ${vehicleno}`],
        [3, `Period: ${periodLabel}`],
        [4, `Generated: ${formatIst(generatedAt)} — ${TZ_NOTE}`],
        [5, ""],
    ] as Array<[number, string]>) {
        const row = sheet.getRow(rowNo);
        row.values = [text];
        row.commit();
    }

    // Every field the charging-cycle spec requires, in its order.
    writeHeaderRow(
        sheet,
        [
            "Charging Cycle No.",
            "Start Timestamp",
            "End Timestamp",
            "Start SOC",
            "End SOC",
            "SOC Difference (%)",
            "Charging Duration",
            "Avg Charging Current (A)",
            "Peak Charging Current (A)",
            "Total Charged AH",
            "Data Coverage (%)",
            "Total CAN Samples",
            "Avg Sampling Interval (s)",
            "Estimated Battery Capacity (Ah)",
            "Rated Capacity (Ah)",
            "Confidence",
        ],
        HEADER_ROW,
    );

    cycles.forEach((cycle, i) => {
        const row = sheet.getRow(HEADER_ROW + 1 + i);
        row.values = [
            cycleSheetName(i + 1),
            formatIst(cycle.start_time),
            formatIst(cycle.end_time),
            cycle.start_soc,
            cycle.end_soc,
            cycle.soc_difference,
            formatDuration(cycle.duration_s),
            cycle.avg_charging_current,
            cycle.max_charging_current,
            cycle.ah_charged,
            cycle.coverage_pct,
            cycle.n_samples,
            cycle.avg_sampling_interval_s,
            // Present on EVERY cycle now. What decides whether to believe it is the
            // Confidence column beside it, not its absence.
            cycle.estimated_capacity_ah,
            cycle.rated_capacity_ah,
            cycle.capacity_confidence.toUpperCase(),
        ];

        // A LOW-confidence estimate is arithmetically valid and epistemically worthless. Grey it
        // so a reader scanning the column cannot mistake it for a measurement.
        if (cycle.capacity_confidence === "low") {
            row.getCell(14).font = { color: { argb: "FF9CA3AF" }, italic: true };
            row.getCell(16).font = { color: { argb: "FF9CA3AF" }, italic: true };
        }
        // An estimate that contradicts the nameplate is a measurement fault. Make it
        // impossible to read past.
        if (cycle.estimated_capacity_ah != null && !cycle.capacity_plausible) {
            row.getCell(14).font = { bold: true, color: { argb: "FFC00000" } };
        }
        row.commit();
    });

    const footnote = sheet.getRow(HEADER_ROW + cycles.length + 2);
    footnote.values = [
        "Estimated capacity = Total Charged AH ÷ (SOC Difference / 100), and it is calculated for EVERY cycle whose SOC rose — " +
            "no cycle is rejected for being small. What varies is how far the number can be trusted, and that is the Confidence column. " +
            `HIGH means the SOC swing was ≥ ${CAPACITY_SOC_THRESHOLD}%, coverage ≥ ${MIN_COVERAGE_PCT}%, and there were ≥ ${MIN_CYCLE_SAMPLES} samples. ` +
            "LOW (shown greyed) means the number is arithmetically valid but the evidence behind it is thin: the division amplifies any error " +
            "in Total AH by 100 ÷ SOC Difference, so a 2% swing multiplies it fiftyfold. Do not read a degradation trend through LOW rows. " +
            `Data Coverage is the share of the cycle's elapsed time spanned by intervals of ${COVERAGE_TRUST_GAP_S}s or less — a low value means ` +
            "the AH total leans on interpolation across gaps between samples. Avg Sampling Interval is the cycle's duration divided by (samples − 1). " +
            "Total Charged AH is the trapezoidal integral of |current| over the cycle's real elapsed time. " +
            "An estimate shown in red contradicts the battery's rated capacity and indicates a measurement fault on that cycle, not a degraded pack.",
    ];
    footnote.font = { italic: true, size: 9 };
    footnote.commit();

    sheet.commit();
}

function writeCycleSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    name: string,
    cycle: ChargingCycleAggregate,
    cycleSamples: ChargingSample[],
) {
    const sheet = workbook.addWorksheet(name, {
        views: [{ state: "frozen", ySplit: 1 }],
    });
    setWidths(sheet, [21, 8, 13, 13, 19, 14, 13]);
    writeHeaderRow(sheet, [
        "Timestamp",
        "SOC",
        "Current (A)",
        "Voltage (V)",
        "Time Difference (s)",
        "AH Increment",
        "Running AH",
    ]);

    let runningAh = 0;
    let rowNo = 2;
    cycleSamples.forEach((sample, i) => {
        // The first sample's interval reaches back into the idle period before the
        // charger was plugged in — it is not part of the charge and SQL excludes it
        // from Total AH, so it must read 0 here too or the sheet won't reconcile.
        const increment = i === 0 ? 0 : ahIncrement(sample);
        runningAh += increment;
        const row = sheet.getRow(rowNo++);
        row.values = [
            formatIst(sample.time),
            sample.soc_pct,
            sample.pack_current,
            sample.pack_voltage,
            i === 0 ? null : sample.dt_s != null ? round(sample.dt_s, 1) : null,
            round(increment, 4),
            round(runningAh, 3),
        ];
        row.commit();
    });

    // Footer values are the aggregate's, not the running totals above: the raw
    // rows are evidence, the aggregate is the number the dashboard shows.
    rowNo += 1;
    for (const [label, value] of [
        ["Total Charging Duration", formatDuration(cycle.duration_s)],
        ["Total Charged AH", cycle.ah_charged],
        ["SOC Difference (%)", cycle.soc_difference],
        ["Avg Charging Current (A)", cycle.avg_charging_current],
        ["Peak Charging Current (A)", cycle.max_charging_current],
        ["Total CAN Samples", cycle.n_samples],
        ["Avg Sampling Interval (s)", cycle.avg_sampling_interval_s],
        ["Data Coverage (%)", cycle.coverage_pct],
        // Always a number now. Whether to believe it is the next row's job.
        ["Estimated Battery Capacity (Ah)", cycle.estimated_capacity_ah],
        [
            "Capacity Confidence",
            cycle.capacity_confidence === "high"
                ? "HIGH — swing, coverage and sample count all support this number"
                : cycle.capacity_confidence === "medium"
                  ? "MEDIUM — usable, but not solid enough to read a trend through"
                  : `LOW — arithmetically valid, but the evidence is thin. Capacity divides by the SOC swing (${cycle.soc_difference}%), so any error in Total Charged AH is multiplied by ${cycle.soc_difference ? Math.round(100 / cycle.soc_difference) : "—"}x. Do not trend through this.`,
        ],
        ["Rated Capacity (Ah)", cycle.rated_capacity_ah],
    ] as Array<[string, string | number | null]>) {
        const row = sheet.getRow(rowNo++);
        row.values = [label, value];
        row.getCell(1).font = { bold: true };
        row.commit();
    }

    const note = sheet.getRow(rowNo + 1);
    note.values = [
        "AH Increment is the trapezoidal integral over the interval ENDING at each row: " +
            "(|previous current| + |this current|) / 2 × Time Difference / 3600. Summing the column reproduces Total AH. " +
            "The first row carries no increment: its interval spans the idle time before charging began, so the cycle's " +
            "AH is integrated over [Start Timestamp, End Timestamp] exactly. " +
            "Rows with a flat SOC, and interior pauses where current drops to 0, remain part of the cycle — SOC is " +
            "quantised to whole percent and current keeps flowing between ticks, so skipping them would under-count the charge.",
    ];
    note.font = { italic: true, size: 9 };
    note.commit();

    sheet.commit();
}

function writeMasterSheet(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    vehicleno: string,
    samples: ChargingSample[],
    cycleNoByBreakId: Map<number, number>,
) {
    const sheet = workbook.addWorksheet("Master Raw Data", {
        views: [{ state: "frozen", ySplit: 1 }],
    });
    setWidths(sheet, [21, 18, 18, 8, 12, 12, 16]);
    writeHeaderRow(sheet, [
        "Timestamp",
        "Charging Cycle ID",
        "Battery Number",
        "SOC",
        "Current",
        "Voltage",
        "Charging Status",
    ]);

    let rowNo = 2;
    for (const sample of samples) {
        // A sample can read "Charging" with no cycle ID: its run was rejected by the
        // SOC-swing / AH > 0 filter. That is exactly the case an engineer checking
        // cycle detection wants to be able to spot.
        const cycleNo = sample.in_valid_cycle
            ? cycleNoByBreakId.get(sample.break_id)
            : undefined;
        const row = sheet.getRow(rowNo++);
        row.values = [
            formatIst(sample.time),
            cycleNo ? cycleSheetName(cycleNo) : "",
            vehicleno,
            sample.soc_pct,
            sample.pack_current,
            sample.pack_voltage,
            sample.in_cycle ? "Charging" : "Not Charging",
        ];
        row.commit();
    }

    sheet.commit();
}
