'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Info, Route, Gauge, Car } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ActivityRow {
    vehicle_number: string;
    customer_name: string | null;
    day: string;
    distance_km: number;
}

interface ActivityData {
    rows: ActivityRow[];
    /** 0 = the per-trip aggregator in iot_stack still has not run. */
    tripsTableRows: number;
    summary: { vehicles: number; totalKm: number; avgKmPerDay: number };
}

/**
 * Fleet Activity — per vehicle, per day.
 *
 * This tab used to read the `trips` table and render an empty table, because `trips` has zero
 * rows across the whole fleet: the per-trip segmentation job in iot_stack has never run. An
 * empty table over a live fleet does not say "the data is missing", it says "nothing happened"
 * — which was false for 873,715 km of driving.
 *
 * So it now shows what actually exists (daily distance, from distance_rollup) and says plainly
 * what does not. The banner disappears on its own the day the aggregator starts writing.
 */
export function TripAnalytics() {
    const { data, isLoading } = useQuery<ActivityData>({
        queryKey: ['intellicar-vehicle-activity'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/trips/overview?limit=200');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data as ActivityData;
        },
    });

    const rows = data?.rows ?? [];
    const s = data?.summary;
    const tripsMissing = (data?.tripsTableRows ?? 0) === 0;

    const dayFmt = (iso: string) =>
        new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

    return (
        <div className="space-y-6">
            {/* The banner is the point. A reader who sees daily rows where they expected trips is
              * owed an explanation, and "the aggregator never ran" is the true one. */}
            {tripsMissing && !isLoading && (
                <div className="flex gap-2.5 p-3.5 rounded-xl bg-amber-50 border border-amber-100">
                    <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-900 space-y-1.5">
                        <p>
                            <strong>Per-trip detail is not available.</strong> The <code>trips</code> table on
                            the telemetry database is empty across the entire fleet — the trip-segmentation
                            job in <code>iot_stack</code> has never run — so start and end points, trip
                            duration and average speed do not exist to show.
                        </p>
                        <p>
                            What is shown below is <strong>daily distance per vehicle</strong>, from the
                            distance rollup, which is populated. A day is the finest grain currently
                            available. Restoring per-trip detail is a job for the telemetry pipeline, not a
                            query fix — this panel will pick it up automatically once the aggregator runs.
                        </p>
                    </div>
                </div>
            )}

            {s && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <StatCard icon={Car} color="text-blue-600" label="Active Vehicles" value={String(s.vehicles)} hint="drove in the last 30 days" />
                    <StatCard icon={Route} color="text-green-600" label="Distance (30 days)" value={`${s.totalKm.toLocaleString()} km`} hint="fleet total" />
                    <StatCard icon={Gauge} color="text-purple-600" label="Avg per Vehicle-Day" value={`${s.avgKmPerDay} km`} hint="across active days" />
                </div>
            )}

            <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="p-4 border-b border-gray-100 flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-semibold text-gray-900">Fleet Activity</h3>
                    <span className="text-xs text-gray-400">
                        Daily distance per vehicle, most recent first
                    </span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                                <th className="px-4 py-3 font-medium">Vehicle</th>
                                <th className="px-4 py-3 font-medium">Customer</th>
                                <th className="px-4 py-3 font-medium">Date</th>
                                <th className="px-4 py-3 font-medium text-right">Distance</th>
                            </tr>
                        </thead>
                        <tbody>
                            {isLoading ? (
                                <tr>
                                    <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                                        <Loader2 className="w-5 h-5 animate-spin inline" />
                                    </td>
                                </tr>
                            ) : rows.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                                        No vehicle activity recorded
                                    </td>
                                </tr>
                            ) : (
                                rows.map((r, i) => (
                                    <tr key={`${r.vehicle_number}-${r.day}-${i}`} className="border-b border-gray-50 hover:bg-gray-50/50">
                                        <td className="px-4 py-3 font-medium">{r.vehicle_number}</td>
                                        <td className="px-4 py-3 text-gray-600">{r.customer_name || '-'}</td>
                                        <td className="px-4 py-3 text-gray-500 text-xs">{dayFmt(r.day)}</td>
                                        <td className="px-4 py-3 font-medium text-right tabular-nums">
                                            {r.distance_km.toFixed(1)} km
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

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
