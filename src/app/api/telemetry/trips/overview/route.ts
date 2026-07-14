import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchVehicleActivity } from '@/lib/telemetry/queries';

// Fleet activity, per vehicle per day, from distance_rollup.
//
// This used to read the `trips` table, which is EMPTY across the whole fleet — the per-trip
// aggregator in iot_stack has never run — so the panel rendered an empty table over a fleet
// that was demonstrably driving. See docs/intellicar-calculations.md §15.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { searchParams } = new URL(req.url);
        const raw = parseInt(searchParams.get('limit') || '100', 10);
        const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100;

        const data = await fetchVehicleActivity(limit);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Vehicle Activity] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
