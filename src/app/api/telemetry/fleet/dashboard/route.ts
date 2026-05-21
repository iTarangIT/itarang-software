import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchFleetDashboardCEO, fetchFleetDashboardDealer } from '@/lib/telemetry/queries';

function isVpsUnreachable(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return true;
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNREFUSED|getaddrinfo|connection terminated|IOT_DATABASE_URL is not set/i.test(message);
}

export async function GET() {
    let user;
    try {
        user = await requireRole(['ceo', 'dealer']);
    } catch (error) {
        // Auth failures keep their original 5xx shape — the degraded path only
        // applies once we've authed and *then* fail to reach the VPS.
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }

    try {
        const data = user.role === 'ceo'
            ? await fetchFleetDashboardCEO()
            : await fetchFleetDashboardDealer(user.dealer_id || '');
        return NextResponse.json({ success: true, data });
    } catch (error) {
        if (isVpsUnreachable(error)) {
            const emptyData = user.role === 'ceo'
                ? {
                    role: 'ceo' as const,
                    kpis: { fleetSize: 0, utilization: 0, avgSOH: 0, warrantyAtRisk: 0, activeAlerts: 0 },
                    warrantyRisk: { trend: [], atRiskDevices: 0 },
                    dealerPerformance: [],
                    serviceMetrics: { fleetUptime: 0, avgDailyDistance: 0, offlineDevices: 0 },
                }
                : {
                    role: 'dealer' as const,
                    kpis: { vehicleCount: 0, avgSOC: 0, faultyDevices: 0, activeToday: 0, energy24h: 0 },
                };
            return NextResponse.json({
                success: true,
                degraded: true,
                reason: 'IoT VPS unreachable — start the SSH tunnel to 127.0.0.1:5433 to see live data.',
                data: emptyData,
            });
        }
        console.error('[Telemetry Dashboard] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
