import { NextRequest, NextResponse } from 'next/server';
import { acknowledgeAlert } from '@/lib/telemetry/queries';
import { requireTelemetryViewer, telemetryErrorResponse, viewerMayOpenVehicle } from '@/lib/telemetry/vehicleAccess';
import { alertVehicleNumber } from '@/lib/telemetry/vehicleAccessRules';

export async function POST(req: NextRequest) {
    try {
        const viewer = await requireTelemetryViewer();
        const { alertId } = await req.json();
        if (!alertId) {
            return NextResponse.json({ success: false, error: { message: 'alertId required' } }, { status: 400 });
        }
        // ID 181: a dealer may resolve only alerts of vehicles mapped to it.
        const vehicleNo = alertVehicleNumber(alertId);
        if (!vehicleNo || !(await viewerMayOpenVehicle(viewer, vehicleNo))) {
            return NextResponse.json({ success: false, error: { message: 'Alert not found' } }, { status: 404 });
        }
        await acknowledgeAlert(alertId, viewer.id);
        return NextResponse.json({ success: true });
    } catch (error) {
        return telemetryErrorResponse(error, 'Acknowledge Alert');
    }
}
