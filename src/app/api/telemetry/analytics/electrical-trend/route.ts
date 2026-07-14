import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchElectricalTrend } from '@/lib/telemetry/battery-queries';
import { analyticsError, parseBatteryParams } from '../_params';

// Voltage / current / temperature as bucketed statistics, plus the observed breach counts.
//
// The breach counts are LOWER BOUNDS. A transient lasts seconds; we sample every ~510 s, so we
// catch roughly 1% of them. See docs/intellicar-calculations.md §16-17.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        const { vehicleno, granularity, ...opts } = parsed.params;
        const data = await fetchElectricalTrend(vehicleno, opts, granularity);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return analyticsError('Electrical Trend', error);
    }
}
