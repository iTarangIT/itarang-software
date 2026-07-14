import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchEnergyTrend } from '@/lib/telemetry/battery-queries';
import { analyticsError, parseBatteryParams } from '../_params';

// Ah in and Ah out per bucket, plus their running totals — the cumulative charge/discharge
// view. Charge comes from the same aggregate that feeds the Charging Cycles card, so the two
// can never disagree. See docs/intellicar-calculations.md §13.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        const { vehicleno, granularity, ...opts } = parsed.params;
        const data = await fetchEnergyTrend(vehicleno, opts, granularity);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return analyticsError('Energy Trend', error);
    }
}
