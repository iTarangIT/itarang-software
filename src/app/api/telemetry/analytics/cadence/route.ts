import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchTelemetryCadence } from '@/lib/telemetry/battery-queries';
import { analyticsError, parseBatteryParams } from '../_params';

// The real stored-sample cadence for a battery — median/p90 gap, samples/day, last-seen,
// duplicate %. Honest counter to the "reads every 30 s" expectation: the device streams ~30 s
// but the poller subsamples to ~8.5 min median. See docs/intellicar-calculations.md §1-§4.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        // Cadence has no bucketing, so granularity is unused here (it stays in ...opts, which
        // buildTimeWindow ignores).
        const { vehicleno, ...opts } = parsed.params;
        const data = await fetchTelemetryCadence(vehicleno, opts);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return analyticsError('Telemetry Cadence', error);
    }
}
