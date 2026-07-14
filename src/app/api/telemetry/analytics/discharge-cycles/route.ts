import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDischargeAnalytics } from '@/lib/telemetry/battery-queries';
import { fetchCycleWindowKm } from '@/lib/telemetry/cycle-distance';
import { kmPerAh } from '@/lib/telemetry/discharge-math';
import { analyticsError, parseBatteryParams } from '../_params';

// Per-battery discharge cycles: depth of discharge, Ah out (SOC-derived and coulomb), and
// the divergence between the two. See docs/intellicar-calculations.md §12–13.
//
// The per-cycle distance is merged HERE rather than inside fetchDischargeAnalytics:
// energy-trend and discharge-vs-km reuse that fetcher internally, and they must not pay
// this route's GPS query a second time.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        const { vehicleno, ...opts } = parsed.params;
        const data = await fetchDischargeAnalytics(vehicleno, opts);

        const kmByCycle = await fetchCycleWindowKm(
            vehicleno,
            opts,
            data.cycles.map((c) => ({
                id: c.break_id,
                start: new Date(c.start_time),
                end: new Date(c.end_time),
            })),
        );
        const cycles = data.cycles.map((c) => {
            const dist = kmByCycle.get(c.break_id) ?? null;
            return {
                ...c,
                km: dist?.km ?? null,
                km_source: dist?.source ?? null,
                km_per_ah: dist ? kmPerAh(dist.km, c.ah_discharged_soc) : null,
            };
        });

        return NextResponse.json({ success: true, data: { ...data, cycles } });
    } catch (error) {
        return analyticsError('Discharge Cycles', error);
    }
}
