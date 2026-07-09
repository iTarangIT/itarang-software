'use client';

import { useState, useRef, useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Loader2, BatteryCharging, Zap, Gauge, Repeat, Clock, TrendingUp, Calendar, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

type Months = 1 | 3 | 6;
const PERIODS: { value: Months; label: string }[] = [
    { value: 1, label: '1 Month' },
    { value: 3, label: '3 Months' },
    { value: 6, label: '6 Months' },
];

interface AhSession {
    start_time: string;
    end_time: string;
    duration_s: number;
    ah_charged: number;
    start_soc: number | null;
    end_soc: number | null;
    estimated_capacity_ah: number | null;
}

interface AhAnalytics {
    vehicleno: string;
    months: number | null;
    month: string | null;
    sessions: AhSession[];
    summary: {
        chargingCycles: number;
        totalAhCharged: number;
        avgAhPerSession: number;
        avgCapacityAh: number | null;
        avgSessionDurationMin: number;
        avgSocGained: number;
    };
}

export function TripAnalytics() {
    const [battery, setBattery] = useState('');
    const [months, setMonths] = useState<Months>(3);
    const [month, setMonth] = useState(''); // specific calendar month YYYY-MM; overrides months when set

    // Human label for the active period (specific month or rolling window).
    const periodLabel = month
        ? new Date(`${month}-01T00:00:00`).toLocaleString('default', { month: 'long', year: 'numeric' })
        : `${months} Month${months > 1 ? 's' : ''}`;

    // Battery options (reuse the devices endpoint; device_id === vehicleno).
    // limit=1000 fetches the whole fleet (~309) so the searchable picker covers everyone.
    const { data: devicesData } = useQuery({
        queryKey: ['intellicar-battery-options'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/devices?limit=1000');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data as Array<Record<string, unknown>>;
        },
    });
    const batteries = Array.isArray(devicesData) ? devicesData : [];

    // AH analytics for the selected battery + period. A chosen month wins over
    // the rolling 1/3/6-month window.
    const periodParam = month ? `month=${month}` : `months=${months}`;
    const { data: ah, isFetching: ahLoading } = useQuery<AhAnalytics>({
        queryKey: ['intellicar-ah-trend', battery, month || `m${months}`],
        enabled: !!battery,
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const res = await fetch(`/api/telemetry/analytics/ah-trend?vehicleno=${encodeURIComponent(battery)}&${periodParam}`);
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data as AhAnalytics;
        },
    });

    // Fleet-wide trip history (unchanged).
    const { data: tripsData, isLoading: tripsLoading } = useQuery({
        queryKey: ['intellicar-trips-overview'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/trips/overview?limit=50');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });
    const trips = Array.isArray(tripsData) ? tripsData : [];

    const chartData = (ah?.sessions ?? []).map((s) => ({
        t: new Date(s.start_time).toLocaleDateString(),
        ah: s.ah_charged,
        capacity: s.estimated_capacity_ah,
    }));
    const summary = ah?.summary;

    return (
        <div className="space-y-6">
            {/* Controls: battery selection + period */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500">
                    <BatteryCharging className="w-4 h-4 text-gray-400" /> Battery
                </span>
                <BatteryPicker value={battery} onChange={setBattery} options={batteries} />

                <div className="flex flex-wrap items-center gap-2 ml-auto">
                    {/* Specific month picker */}
                    <MonthPicker value={month} onChange={setMonth} max={new Date().toISOString().slice(0, 7)} />
                    {/* Rolling window */}
                    <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg">
                        {PERIODS.map((p) => (
                            <button
                                key={p.value}
                                type="button"
                                onClick={() => { setMonths(p.value); setMonth(''); }}
                                className={cn(
                                    'px-3 py-1.5 rounded-md text-sm font-medium transition-all',
                                    !month && months === p.value ? 'bg-white text-brand-700 shadow-sm' : 'text-gray-500 hover:text-gray-700',
                                )}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {!battery ? (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center text-gray-400 text-sm">
                    <BatteryCharging className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                    Select a battery to view AH analytics.
                </div>
            ) : ahLoading && !ah ? (
                <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-brand-600 animate-spin" /></div>
            ) : (
                <>
                    {/* Charging statistics */}
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                        <StatCard icon={Repeat} color="text-blue-600" label="Charging Cycles" value={String(summary?.chargingCycles ?? 0)} />
                        <StatCard icon={Zap} color="text-amber-600" label="Total AH Charged" value={`${summary?.totalAhCharged ?? 0} Ah`} />
                        <StatCard icon={TrendingUp} color="text-green-600" label="Avg AH / Session" value={`${summary?.avgAhPerSession ?? 0} Ah`} />
                        <StatCard icon={Gauge} color="text-purple-600" label="Avg Capacity" value={summary?.avgCapacityAh != null ? `${summary.avgCapacityAh} Ah` : 'N/A'} />
                        <StatCard icon={Clock} color="text-gray-600" label="Avg Duration" value={`${summary?.avgSessionDurationMin ?? 0} min`} />
                    </div>

                    {/* AH Trend */}
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
                        <h3 className="text-sm font-semibold text-gray-900 mb-4">AH Trend ({periodLabel})</h3>
                        {chartData.length > 0 ? (
                            <ResponsiveContainer width="100%" height={300}>
                                <LineChart data={chartData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                    <XAxis dataKey="t" tick={{ fontSize: 11 }} />
                                    <YAxis tick={{ fontSize: 11 }} label={{ value: 'Ah', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                                    <Tooltip />
                                    <Legend />
                                    <Line type="monotone" dataKey="ah" name="AH Charged" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} />
                                </LineChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="h-48 flex items-center justify-center text-gray-400 text-sm">No charging sessions in this period</div>
                        )}
                    </div>

                    {/* Battery Capacity Trend */}
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
                        <h3 className="text-sm font-semibold text-gray-900 mb-1">Battery Capacity Trend</h3>
                        <p className="text-xs text-gray-400 mb-4">Full (100%) capacity extrapolated from each charging session&apos;s AH ÷ ΔSOC.</p>
                        {chartData.some((d) => d.capacity != null) ? (
                            <ResponsiveContainer width="100%" height={300}>
                                <LineChart data={chartData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                    <XAxis dataKey="t" tick={{ fontSize: 11 }} />
                                    <YAxis tick={{ fontSize: 11 }} label={{ value: 'Ah', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                                    <Tooltip />
                                    <Legend />
                                    <Line type="monotone" dataKey="capacity" name="Est. Capacity" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                                </LineChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="h-48 flex items-center justify-center text-gray-400 text-sm">Not enough SOC movement to estimate capacity</div>
                        )}
                    </div>
                </>
            )}

            {/* Trip History (fleet-wide) */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="p-4 border-b border-gray-100">
                    <h3 className="text-sm font-semibold text-gray-900">Trip History</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                                <th className="px-4 py-3 font-medium">Vehicle</th>
                                <th className="px-4 py-3 font-medium">Customer</th>
                                <th className="px-4 py-3 font-medium">Start</th>
                                <th className="px-4 py-3 font-medium">End</th>
                                <th className="px-4 py-3 font-medium">Distance</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tripsLoading ? (
                                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline" /></td></tr>
                            ) : trips.length === 0 ? (
                                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No trips found</td></tr>
                            ) : trips.map((t: Record<string, unknown>, i: number) => (
                                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                                    <td className="px-4 py-3 font-medium">{String(t.vehicle_number || t.device_id || '-')}</td>
                                    <td className="px-4 py-3 text-gray-600">{String(t.customer_name || '-')}</td>
                                    <td className="px-4 py-3 text-gray-500 text-xs">{t.start_time ? new Date(String(t.start_time)).toLocaleString() : '-'}</td>
                                    <td className="px-4 py-3 text-gray-500 text-xs">{t.end_time ? new Date(String(t.end_time)).toLocaleString() : '-'}</td>
                                    <td className="px-4 py-3 font-medium">{t.distance_km ? `${Number(t.distance_km).toFixed(1)} km` : '-'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Interactive month picker: a button that opens a popover with a year stepper
 * and a 12-month grid. `value`/`max` are 'YYYY-MM'; future months are disabled.
 * Empty value shows "Pick month". Choosing a month calls onChange; a footer
 * "Clear" resets to the rolling window.
 */
function MonthPicker({ value, onChange, max }: { value: string; onChange: (v: string) => void; max: string }) {
    const [open, setOpen] = useState(false);
    const [viewYear, setViewYear] = useState(() => Number((value || max).slice(0, 4)));
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const maxYear = Number(max.slice(0, 4));
    const maxMonth = Number(max.slice(5, 7));
    const selYear = value ? Number(value.slice(0, 4)) : null;
    const selMonth = value ? Number(value.slice(5, 7)) : null;
    const label = value
        ? new Date(`${value}-01T00:00:00`).toLocaleString('default', { month: 'short', year: 'numeric' })
        : 'Pick month';

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'inline-flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg bg-white transition-colors',
                    value ? 'border-brand-300 text-brand-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                )}
            >
                <Calendar className="w-4 h-4 text-gray-400" />
                {label}
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute z-20 mt-2 right-0 w-64 bg-white border border-gray-100 rounded-xl shadow-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                        <button type="button" onClick={() => setViewYear((y) => y - 1)} className="p-1 rounded-md hover:bg-gray-100 text-gray-600">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-sm font-semibold text-gray-900">{viewYear}</span>
                        <button
                            type="button"
                            disabled={viewYear >= maxYear}
                            onClick={() => setViewYear((y) => y + 1)}
                            className="p-1 rounded-md hover:bg-gray-100 text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                        {MONTH_NAMES.map((name, i) => {
                            const m = i + 1;
                            const disabled = viewYear > maxYear || (viewYear === maxYear && m > maxMonth);
                            const active = selYear === viewYear && selMonth === m;
                            return (
                                <button
                                    key={m}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => { onChange(`${viewYear}-${String(m).padStart(2, '0')}`); setOpen(false); }}
                                    className={cn(
                                        'px-2 py-1.5 text-sm rounded-md transition-colors',
                                        active ? 'bg-brand-600 text-white' : disabled ? 'text-gray-300 cursor-not-allowed' : 'text-gray-700 hover:bg-gray-100',
                                    )}
                                >
                                    {name}
                                </button>
                            );
                        })}
                    </div>
                    {value && (
                        <div className="mt-2 pt-2 border-t border-gray-100 text-right">
                            <button type="button" onClick={() => { onChange(''); setOpen(false); }} className="text-xs font-medium text-brand-600 hover:underline">
                                Clear
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Searchable battery picker: a button that opens a popover with a search box and a
 * scrollable, client-side-filtered list of the whole fleet (matches on vehicle no /
 * device_id and customer name). Choosing one calls onChange; outside-click closes.
 */
function BatteryPicker({
    value,
    onChange,
    options,
}: {
    value: string;
    onChange: (v: string) => void;
    options: Array<Record<string, unknown>>;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const ref = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    useEffect(() => {
        if (open) inputRef.current?.focus();
    }, [open]);

    const items = options
        .map((b) => ({
            id: String(b.device_id || b.vehicle_number || ''),
            name: b.customer_name ? String(b.customer_name) : '',
        }))
        .filter((o) => o.id);

    const needle = q.trim().toLowerCase();
    const filtered = needle
        ? items.filter((o) => o.id.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle))
        : items;

    const selected = items.find((o) => o.id === value);
    const label = selected
        ? `${selected.id}${selected.name ? ` — ${selected.name}` : ''}`
        : 'Select a battery…';

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'inline-flex items-center gap-2 px-3 py-2 text-sm border rounded-lg bg-white transition-colors min-w-[240px] max-w-[320px]',
                    value ? 'border-brand-300 text-brand-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                )}
            >
                <BatteryCharging className="w-4 h-4 text-gray-400 shrink-0" />
                <span className="truncate flex-1 text-left">{label}</span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform shrink-0', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute z-20 mt-2 left-0 w-72 bg-white border border-gray-100 rounded-xl shadow-lg p-2">
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1 border-b border-gray-100">
                        <Search className="w-4 h-4 text-gray-400 shrink-0" />
                        <input
                            ref={inputRef}
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Search vehicle no or customer…"
                            className="w-full text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none"
                        />
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                        {filtered.length === 0 ? (
                            <div className="px-3 py-6 text-center text-sm text-gray-400">No matches</div>
                        ) : (
                            filtered.map((o) => (
                                <button
                                    key={o.id}
                                    type="button"
                                    onClick={() => { onChange(o.id); setOpen(false); setQ(''); }}
                                    className={cn(
                                        'w-full text-left px-3 py-2 text-sm rounded-md transition-colors',
                                        o.id === value ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100',
                                    )}
                                >
                                    <span className="font-medium">{o.id}</span>
                                    {o.name && (
                                        <span className={cn('ml-1', o.id === value ? 'text-brand-100' : 'text-gray-400')}>— {o.name}</span>
                                    )}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function StatCard({ icon: Icon, color, label, value }: { icon: React.ElementType; color: string; label: string; value: string }) {
    return (
        <div className="p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
                <Icon className={cn('w-4 h-4', color)} />
                <span className="text-xs font-medium text-gray-500">{label}</span>
            </div>
            <p className="text-xl font-bold text-gray-900">{value}</p>
        </div>
    );
}
