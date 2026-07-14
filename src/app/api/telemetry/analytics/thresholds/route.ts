import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import {
    getBatteryThresholds,
    setBatteryThresholds,
    type BatteryThresholds,
} from '@/lib/telemetry/thresholds';
import { analyticsError } from '../_params';

// Display thresholds for the Battery Analytics red flags. These colour the dashboard; they do
// NOT change what the alert poller fires on — that lives in iot_stack, outside this repo.
// See docs/intellicar-calculations.md §17.

export async function GET() {
    try {
        await requireRole(['ceo']);
        return NextResponse.json({ success: true, data: await getBatteryThresholds() });
    } catch (error) {
        return analyticsError('Thresholds GET', error);
    }
}

const NUMERIC_KEYS: Array<keyof BatteryThresholds> = [
    'underVoltageV',
    'overVoltageV',
    'overCurrentA',
    'weakChargeCurrentA',
    'overTemperatureC',
    'capacityWarningFrac',
    'capacityCriticalFrac',
];

export async function PUT(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const body = (await req.json()) as Record<string, unknown>;

        // Whitelist and coerce: this lands in a jsonb column that later feeds SQL comparisons,
        // so an unknown key or a non-finite number must not survive the round trip.
        const patch: Partial<BatteryThresholds> = {};
        for (const key of NUMERIC_KEYS) {
            if (!(key in body)) continue;
            const n = Number(body[key]);
            if (!Number.isFinite(n) || n <= 0) {
                return NextResponse.json(
                    { success: false, error: { message: `${key} must be a positive number` } },
                    { status: 400 },
                );
            }
            patch[key] = n;
        }

        if (Object.keys(patch).length === 0) {
            return NextResponse.json(
                { success: false, error: { message: 'No recognised threshold in body' } },
                { status: 400 },
            );
        }

        // A warning band at or below the critical band would paint the chart in the wrong
        // order, so the pair is validated together against the merged result, not in isolation.
        const merged = { ...(await getBatteryThresholds()), ...patch };
        if (merged.capacityWarningFrac <= merged.capacityCriticalFrac) {
            return NextResponse.json(
                { success: false, error: { message: 'capacityWarningFrac must exceed capacityCriticalFrac' } },
                { status: 400 },
            );
        }
        if (merged.overVoltageV <= merged.underVoltageV) {
            return NextResponse.json(
                { success: false, error: { message: 'overVoltageV must exceed underVoltageV' } },
                { status: 400 },
            );
        }

        return NextResponse.json({ success: true, data: await setBatteryThresholds(patch) });
    } catch (error) {
        return analyticsError('Thresholds PUT', error);
    }
}
