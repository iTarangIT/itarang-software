import { NextResponse } from "next/server";
import type { ChargingWindowOpts } from "@/lib/telemetry/charging-sql";
import { parseGranularity, type Granularity } from "@/lib/telemetry/battery-queries";

/**
 * The query string every per-battery analytics route takes.
 *
 * Six routes read the same `vehicleno` + period + granularity params. They were each
 * re-parsing it by hand, which is how the precedence between `from`/`to`, `month` and
 * `months` drifts apart from buildTimeWindow() on the server — and once it does, a chart's
 * caption describes a window the query never ran.
 */
export interface BatteryParams extends ChargingWindowOpts {
    vehicleno: string;
    granularity: Granularity;
}

export type ParseResult =
    | { ok: true; params: BatteryParams }
    | { ok: false; response: NextResponse };

export function parseBatteryParams(req: Request): ParseResult {
    const { searchParams } = new URL(req.url);
    const vehicleno = searchParams.get("vehicleno")?.trim();

    if (!vehicleno) {
        return {
            ok: false,
            response: NextResponse.json(
                { success: false, error: { message: "vehicleno is required" } },
                { status: 400 },
            ),
        };
    }

    return {
        ok: true,
        params: {
            vehicleno,
            months: parseInt(searchParams.get("months") || "3", 10),
            month: searchParams.get("month")?.trim() || undefined, // YYYY-MM
            from: searchParams.get("from")?.trim() || undefined, // YYYY-MM-DD
            to: searchParams.get("to")?.trim() || undefined, // YYYY-MM-DD
            granularity: parseGranularity(searchParams.get("granularity")),
        },
    };
}

/** The `{ success, data }` envelope + 500 handling every telemetry route already uses. */
export function analyticsError(label: string, error: unknown) {
    console.error(`[${label}] Error:`, error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
}
