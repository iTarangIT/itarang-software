import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import {
    countChargingSamples,
    fetchChargingCycleAggregate,
    fetchChargingCycleDetail,
} from '@/lib/telemetry/queries';
import {
    buildChargingAnalysisWorkbook,
    MAX_CYCLES,
    MAX_SAMPLES,
} from '@/lib/telemetry/charging-export';

// Charging Analysis workbook for one battery over the Trip Analytics period.
// months ∈ {1,3,6}; a specific `month` (YYYY-MM) overrides it. vehicleno required.
//
// Everything that can fail does so before a single byte of the workbook is
// written, so the client always gets either a clean JSON error or a complete
// .xlsx — never a truncated download behind a 200.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX_MIME =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function badRequest(message: string) {
    return NextResponse.json(
        { success: false, error: { message } },
        { status: 400 },
    );
}

function periodLabel(months: number | null, month: string | null): string {
    if (month) {
        return new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        });
    }
    return `Last ${months} Month${months === 1 ? '' : 's'}`;
}

export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);

        const { searchParams } = new URL(req.url);
        const vehicleno = searchParams.get('vehicleno')?.trim();
        if (!vehicleno) return badRequest('vehicleno is required');

        const month = searchParams.get('month')?.trim() || undefined;
        if (month && !/^\d{4}-\d{2}$/.test(month)) {
            return badRequest('month must be in YYYY-MM format');
        }
        const months = parseInt(searchParams.get('months') || '3', 10);
        const opts = { months, month };

        // Reject an oversized window before any rows cross the wire. ExcelJS cells
        // cost a few hundred bytes each, and sandbox shares its 8 GB box with prod.
        const sampleCount = await countChargingSamples(vehicleno, opts);
        if (sampleCount === 0) {
            return badRequest(
                `No telemetry found for ${vehicleno} in the selected period.`,
            );
        }
        if (sampleCount > MAX_SAMPLES) {
            return badRequest(
                `This period has ${sampleCount.toLocaleString()} telemetry samples, above the ` +
                    `${MAX_SAMPLES.toLocaleString()} export limit. Please choose a narrower date range.`,
            );
        }

        const [aggregate, detail] = await Promise.all([
            fetchChargingCycleAggregate(vehicleno, opts),
            fetchChargingCycleDetail(vehicleno, opts),
        ]);

        const { cycles } = aggregate;
        if (cycles.length === 0) {
            return badRequest(
                `No charging cycles were detected for ${vehicleno} in the selected period.`,
            );
        }
        if (cycles.length > MAX_CYCLES) {
            return badRequest(
                `This period has ${cycles.length} charging cycles, above the ${MAX_CYCLES}-sheet ` +
                    `export limit. Please choose a narrower date range.`,
            );
        }

        // Anti-drift guard. The summary and the per-sample sheets come from two
        // queries built on the same shared CTE, so their cycles must agree. If the
        // CTE ever drifts, fail loudly rather than ship a workbook whose raw rows
        // contradict its totals.
        const detailBreakIds = new Set(
            detail.samples.filter((s) => s.in_valid_cycle).map((s) => s.break_id),
        );
        const missing = cycles.filter((c) => !detailBreakIds.has(c.break_id));
        if (missing.length > 0 || detailBreakIds.size !== cycles.length) {
            throw new Error(
                `Charging cycle mismatch for ${vehicleno}: aggregate reported ${cycles.length} ` +
                    `cycles, sample detail reported ${detailBreakIds.size}. Refusing to export.`,
            );
        }

        const buffer = await buildChargingAnalysisWorkbook({
            vehicleno,
            periodLabel: periodLabel(aggregate.months, aggregate.month),
            generatedAt: new Date(),
            cycles,
            samples: detail.samples,
        });

        const safeName = vehicleno.replace(/[^a-zA-Z0-9_-]/g, '_');
        const suffix = aggregate.month ?? `${aggregate.months}m`;
        const filename = `charging-analysis_${safeName}_${suffix}.xlsx`;

        return new Response(new Uint8Array(buffer), {
            status: 200,
            headers: {
                'Content-Type': XLSX_MIME,
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': String(buffer.byteLength),
                'Cache-Control': 'no-store',
            },
        });
    } catch (error) {
        console.error('[Charging Export] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json(
            { success: false, error: { message } },
            { status: 500 },
        );
    }
}
