import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDischargeVsKm } from '@/lib/telemetry/battery-queries';
import { analyticsError, parseBatteryParams } from '../_params';

// Ah discharged against kilometres driven, per DAY.
//
// Per day rather than per discharge cycle, and that is a data constraint, not a preference:
// distance exists only as a daily rollup, and the per-trip `trips` table is empty across the
// whole fleet — so splitting a day's kilometres between the discharge cycles inside it would
// be an invention. See docs/intellicar-calculations.md §15.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        const { vehicleno, ...opts } = parsed.params;
        const data = await fetchDischargeVsKm(vehicleno, opts);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return analyticsError('Discharge vs Km', error);
    }
}
