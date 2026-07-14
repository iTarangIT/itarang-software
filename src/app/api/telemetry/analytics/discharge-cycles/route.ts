import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDischargeAnalytics } from '@/lib/telemetry/battery-queries';
import { analyticsError, parseBatteryParams } from '../_params';

// Per-battery discharge cycles: depth of discharge, Ah out (SOC-derived and coulomb), and
// the divergence between the two. See docs/intellicar-calculations.md §12–13.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        const { vehicleno, ...opts } = parsed.params;
        const data = await fetchDischargeAnalytics(vehicleno, opts);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return analyticsError('Discharge Cycles', error);
    }
}
