'use client';

import { CalendarCheck, Route, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DistanceData } from './types';

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
 * Driver behaviour at a glance: how far, how often, and how much per working day.
 *
 * "Active Days" is day-grained whatever the chart's granularity — a week bucket with one
 * working day must not read as one active week — so the figures aggregate cleanly across
 * a 1/3/6/12-month selection.
 */
export function DriverBehaviourCards({ data }: { data: DistanceData | undefined }) {
    const s = data?.summary;
    const lowerBound = (s?.bucketsWithoutDistance ?? 0) > 0;

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
                icon={Route}
                color="text-blue-600"
                label="Total Kilometres"
                value={`${(s?.totalKm ?? 0).toLocaleString()} km`}
                hint={lowerBound ? 'lower bound — some periods have no distance row' : 'over the selected period'}
            />
            <StatCard
                icon={CalendarCheck}
                color="text-green-600"
                label="Active Days"
                value={String(s?.activeDays ?? 0)}
                hint="days with any distance recorded"
            />
            <StatCard
                icon={TrendingUp}
                color="text-purple-600"
                label="Avg KM / Active Day"
                value={`${s?.avgKmPerActiveDay ?? 0} km`}
                hint="total km ÷ active days"
            />
        </div>
    );
}
