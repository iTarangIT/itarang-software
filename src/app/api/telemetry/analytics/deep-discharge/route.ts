import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDeepDischarge } from '@/lib/telemetry/battery-queries';
import { analyticsError, parseBatteryParams } from '../_params';

// Deep-discharge events (<20% SOC), debounced by a Schmitt trigger so one physical event is
// one row rather than one per sample. See docs/intellicar-calculations.md §14.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        const { vehicleno, ...opts } = parsed.params;
        const data = await fetchDeepDischarge(vehicleno, opts);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return analyticsError('Deep Discharge', error);
    }
}
