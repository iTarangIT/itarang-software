'use client';

import { Zap, Gauge, Repeat, Clock, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AhSummary } from './types';

function StatCard({
    icon: Icon,
    color,
    label,
    value,
    hint,
}: {
    icon: React.ElementType;
    color: string;
    label: string;
    value: string;
    /** Reconciles this figure with the others when they legitimately differ. */
    hint?: string;
}) {
    return (
        <div className="p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
                <Icon className={cn('w-4 h-4', color)} />
                <span className="text-xs font-medium text-gray-500">{label}</span>
            </div>
            <p className="text-xl font-bold text-gray-900">{value}</p>
            {hint && <p className="text-[11px] text-gray-400 mt-0.5 leading-tight">{hint}</p>}
        </div>
    );
}

/**
 * The five headline figures for the selected battery.
 *
 * `plottedCycles` is passed in rather than derived: Charging Cycles counts every detected
 * charge, while the capacity trend plots only the subset we can extrapolate from. Two
 * different numbers on one screen read as a bug unless the smaller one is explained, so
 * the hint reconciles them here rather than leaving the reader to guess.
 */
export function BatteryStatCards({
    summary,
    plottedCycles,
}: {
    summary: AhSummary | undefined;
    plottedCycles: number;
}) {
    const declined = (summary?.chargingCycles ?? 0) - plottedCycles;

    return (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatCard
                icon={Repeat}
                color="text-blue-600"
                label="Charging Cycles"
                value={String(summary?.chargingCycles ?? 0)}
                hint={declined > 0 ? `${plottedCycles} yield a capacity estimate` : undefined}
            />
            <StatCard
                icon={Zap}
                color="text-amber-600"
                label="Total AH Charged"
                value={`${summary?.totalAhCharged ?? 0} Ah`}
                hint="across all detected cycles"
            />
            <StatCard
                icon={TrendingUp}
                color="text-green-600"
                label="Avg AH / Session"
                value={`${summary?.avgAhPerSession ?? 0} Ah`}
            />
            <StatCard
                icon={Gauge}
                color="text-purple-600"
                label="Avg Capacity"
                value={summary?.avgCapacityAh != null ? `${summary.avgCapacityAh} Ah` : 'N/A'}
                hint={plottedCycles > 0 ? `over ${plottedCycles} plotted cycle${plottedCycles === 1 ? '' : 's'}` : undefined}
            />
            <StatCard
                icon={Clock}
                color="text-gray-600"
                label="Avg Duration"
                value={`${summary?.avgSessionDurationMin ?? 0} min`}
            />
        </div>
    );
}
