'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { BatteryCharging, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BatteryPicker } from './BatteryPicker';
import { PeriodFilterBar } from './PeriodFilterBar';
import { ExportChargingAnalysis } from './ExportChargingAnalysis';
import { BatteryStatCards } from './BatteryStatCards';
import { DriverBehaviourCards } from './DriverBehaviourCards';
import { usePeriod } from './usePeriod';
import type {
    AhAnalytics,
    BatteryThresholds,
    DeepDischargeData,
    DischargeAnalytics,
    DischargeKmData,
    DistanceData,
    ElectricalData,
    SocTimeline,
    BatteryGeoData,
    TelemetryCadence,
} from './types';

// recharts is ~100 KB of client JS, and there are a dozen charts here. Each sub-tab loads its
// own chunk on first open, so a reader who only ever looks at Capacity never downloads the
// scatter, the envelopes, or the timeline.
const ChartFallback = () => (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm h-[380px] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gray-300 animate-spin" />
    </div>
);

// next/dynamic's options must be an inline object literal — the compiler plugin reads them
// statically to emit the chunk boundary, so a shared `const lazy = {...}` fails the build.
const CapacityDegradationChart = dynamic(
    () => import('./charts/CapacityDegradationChart').then((m) => m.CapacityDegradationChart),
    { ssr: false, loading: ChartFallback },
);
const CapacityByPeriodChart = dynamic(
    () => import('./charts/CapacityByPeriodChart').then((m) => m.CapacityByPeriodChart),
    { ssr: false, loading: ChartFallback },
);
const MonthlyEnergyDistanceChart = dynamic(
    () => import('./charts/EnergyCharts').then((m) => m.MonthlyEnergyDistanceChart),
    { ssr: false, loading: ChartFallback },
);
const DeepDischargeChart = dynamic(
    () => import('./charts/EnergyCharts').then((m) => m.DeepDischargeChart),
    { ssr: false, loading: ChartFallback },
);
const DistanceTrendChart = dynamic(
    () => import('./charts/DistanceCharts').then((m) => m.DistanceTrendChart),
    { ssr: false, loading: ChartFallback },
);
const MileageTrendChart = dynamic(
    () => import('./charts/DistanceCharts').then((m) => m.MileageTrendChart),
    { ssr: false, loading: ChartFallback },
);
const DischargeVsKmChart = dynamic(
    () => import('./charts/DistanceCharts').then((m) => m.DischargeVsKmChart),
    { ssr: false, loading: ChartFallback },
);
const PerCycleMileageChart = dynamic(
    () => import('./charts/DistanceCharts').then((m) => m.PerCycleMileageChart),
    { ssr: false, loading: ChartFallback },
);
const AhVsMileageChart = dynamic(
    () => import('./charts/DistanceCharts').then((m) => m.AhVsMileageChart),
    { ssr: false, loading: ChartFallback },
);
const VoltageTrendChart = dynamic(
    () => import('./charts/ElectricalCharts').then((m) => m.VoltageTrendChart),
    { ssr: false, loading: ChartFallback },
);
const CurrentTrendChart = dynamic(
    () => import('./charts/ElectricalCharts').then((m) => m.CurrentTrendChart),
    { ssr: false, loading: ChartFallback },
);
const RedFlagCards = dynamic(
    () => import('./charts/ElectricalCharts').then((m) => m.RedFlagCards),
    { ssr: false },
);
const ChargingTimeline = dynamic(
    () => import('./charts/ChargingTimeline').then((m) => m.ChargingTimeline),
    { ssr: false, loading: ChartFallback },
);
// Leaflet touches window at import time, so ssr:false is not an optimisation here — it is the
// only way this renders at all.
const LocationMap = dynamic(
    () => import('./charts/LocationMap').then((m) => m.LocationMap),
    { ssr: false, loading: ChartFallback },
);

type SubTab = 'capacity' | 'energy' | 'usage' | 'location' | 'electrical' | 'timeline';

const SUB_TABS: { id: SubTab; label: string }[] = [
    { id: 'capacity', label: 'Capacity & Health' },
    { id: 'energy', label: 'Energy' },
    { id: 'usage', label: 'Usage & Distance' },
    { id: 'location', label: 'Location' },
    { id: 'electrical', label: 'Electrical' },
    { id: 'timeline', label: 'Timeline' },
];

/** Which endpoints each sub-tab actually needs. Nothing else is fetched. */
const NEEDS: Record<SubTab, { ah?: true; discharge?: true; deep?: true; distance?: true; monthly?: true; km?: true; electrical?: true; timeline?: true; geo?: true }> = {
    capacity: { ah: true },
    energy: { monthly: true, deep: true },
    usage: { distance: true, km: true },
    location: { geo: true },
    electrical: { electrical: true },
    timeline: { timeline: true, ah: true, discharge: true },
};

async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Request failed');
    }
    return (await res.json()).data as T;
}

// "Read every 30 s": each active-tab query re-fetches on this interval (only the enabled
// queries for the current tab poll, and only while the tab is focused). Honest caveat lives on
// the cadence readout — the stored feed updates ~every 8.5 min, so most refetches return the
// same values; polling faster than the poller writes does not raise resolution.
const LIVE_30S = { refetchInterval: 30_000 } as const;

function fmtInterval(s: number | null): string {
    if (s == null) return '—';
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`;
    return `${(s / 3600).toFixed(1)} h`;
}

function fmtAge(iso: string | null): string {
    if (!iso) return '—';
    const min = (Date.now() - new Date(iso).getTime()) / 60_000;
    if (min < 1) return 'just now';
    if (min < 90) return `${Math.round(min)} min ago`;
    const h = min / 60;
    return h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * The honest telemetry-cadence line under the stat cards. It says out loud what "reads every
 * 30 s" really means here: the page refreshes every 30 s, but the poller stores samples ~8.5 min
 * apart, so most refreshes re-read the same values. Better to state the real cadence than to let
 * a fast refresh imply a fast feed.
 */
function CadenceReadout({ cadence }: { cadence: TelemetryCadence | undefined }) {
    if (!cadence) return null;
    return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-gray-400">
            <span className="inline-flex items-center gap-1.5 text-emerald-600">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Live · refreshes every 30 s
            </span>
            <span className="text-gray-300">·</span>
            <span>
                stored telemetry ~{fmtInterval(cadence.medianIntervalS)} apart (median)
                {cadence.samplesPerDay != null ? `, ~${cadence.samplesPerDay}/day` : ''}
            </span>
            {cadence.lastSampleAt && (
                <>
                    <span className="text-gray-300">·</span>
                    <span>last sample {fmtAge(cadence.lastSampleAt)}</span>
                </>
            )}
            <span
                className="text-gray-400/90 underline decoration-dotted underline-offset-2"
                title="The device streams every ~30 s, but the AWS poller subsamples to ~100 rows/day. Refreshing every 30 s re-reads the same stored samples between writes — it does not raise the data's resolution."
            >
                why not 30 s?
            </span>
        </div>
    );
}

/**
 * Battery Analytics — everything scoped to one selected battery.
 *
 * The picker and the period bar are shared state, so they live here. The charts are grouped
 * behind sub-tabs rather than stacked on one scroll: twelve charts on a page would fire six
 * heavy telemetry queries on mount, and nobody reads twelve charts at once anyway.
 */
export function BatteryAnalytics() {
    const [battery, setBattery] = useState('');
    const [tab, setTab] = useState<SubTab>('capacity');
    const period = usePeriod(3);

    const needs = NEEDS[tab];
    const qp = period.periodParam;
    const on = (want: boolean | undefined) => !!battery && !!want;

    const { data: devicesData } = useQuery({
        queryKey: ['intellicar-battery-options'],
        queryFn: () => getJson<Array<Record<string, unknown>>>('/api/telemetry/devices?limit=1000'),
    });
    const batteries = Array.isArray(devicesData) ? devicesData : [];

    // E-190: keyed by battery so a vehicle mapped to a spec model gets its model's
    // limits on the capacity bands and red flags, not the fleet-wide placeholders.
    const { data: thresholds } = useQuery<BatteryThresholds>({
        queryKey: ['intellicar-thresholds', battery],
        queryFn: () =>
            getJson<BatteryThresholds>(
                `/api/telemetry/analytics/thresholds${battery ? `?vehicleno=${encodeURIComponent(battery)}` : ''}`,
            ),
        staleTime: 5 * 60_000,
    });

    // Real stored-sample cadence for the header readout — always on when a battery is picked,
    // and polled every 30 s so the "last sample" age stays live.
    const { data: cadence } = useQuery<TelemetryCadence>({
        queryKey: ['intellicar-cadence', battery, qp],
        enabled: !!battery,
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<TelemetryCadence>(`/api/telemetry/analytics/cadence?vehicleno=${encodeURIComponent(battery)}&${qp}`),
    });

    const v = encodeURIComponent(battery);

    const { data: ah, isFetching: ahLoading } = useQuery<AhAnalytics>({
        queryKey: ['intellicar-ah-trend', battery, qp],
        enabled: on(needs.ah),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<AhAnalytics>(`/api/telemetry/analytics/ah-trend?vehicleno=${v}&${qp}`),
    });

    const { data: discharge } = useQuery<DischargeAnalytics>({
        queryKey: ['intellicar-discharge', battery, qp],
        enabled: on(needs.discharge),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<DischargeAnalytics>(`/api/telemetry/analytics/discharge-cycles?vehicleno=${v}&${qp}`),
    });

    const { data: deep } = useQuery<DeepDischargeData>({
        queryKey: ['intellicar-deep-discharge', battery, qp],
        enabled: on(needs.deep),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<DeepDischargeData>(`/api/telemetry/analytics/deep-discharge?vehicleno=${v}&${qp}`),
    });

    // The monthly overview is pinned to granularity=month whatever the pill says, and keyed
    // by the granularity-free windowParam so flipping the pill cannot refetch it.
    const wp = period.windowParam;
    const { data: energyMonthly } = useQuery<EnergyDataT>({
        queryKey: ['intellicar-energy-monthly', battery, wp],
        enabled: on(needs.monthly),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () =>
            getJson<EnergyDataT>(
                `/api/telemetry/analytics/energy-trend?vehicleno=${v}&${wp}&granularity=month`,
            ),
    });
    const { data: distanceMonthly } = useQuery<DistanceData>({
        queryKey: ['intellicar-distance-monthly', battery, wp],
        enabled: on(needs.monthly),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () =>
            getJson<DistanceData>(
                `/api/telemetry/analytics/distance-trend?vehicleno=${v}&${wp}&granularity=month`,
            ),
    });

    const { data: distance } = useQuery<DistanceData>({
        queryKey: ['intellicar-distance', battery, qp],
        enabled: on(needs.distance),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<DistanceData>(`/api/telemetry/analytics/distance-trend?vehicleno=${v}&${qp}`),
    });

    const { data: km } = useQuery<DischargeKmData>({
        queryKey: ['intellicar-discharge-km', battery, qp],
        enabled: on(needs.km),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<DischargeKmData>(`/api/telemetry/analytics/discharge-vs-km?vehicleno=${v}&${qp}`),
    });

    const { data: electrical } = useQuery<ElectricalData>({
        queryKey: ['intellicar-electrical', battery, qp],
        enabled: on(needs.electrical),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<ElectricalData>(`/api/telemetry/analytics/electrical-trend?vehicleno=${v}&${qp}`),
    });

    const { data: geo } = useQuery<BatteryGeoData>({
        queryKey: ['intellicar-geo', battery, qp],
        enabled: on(needs.geo),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<BatteryGeoData>(`/api/telemetry/analytics/geo?vehicleno=${v}&${qp}`),
    });

    const { data: timeline } = useQuery<SocTimeline>({
        queryKey: ['intellicar-soc-timeline', battery, qp],
        enabled: on(needs.timeline),
        placeholderData: keepPreviousData,
        ...LIVE_30S,
        queryFn: () => getJson<SocTimeline>(`/api/telemetry/analytics/soc-timeline?vehicleno=${v}&${qp}`),
    });

    const sessions = ah?.sessions ?? [];
    const plottedCycles = sessions.filter((s) => s.estimated_capacity_ah != null).length;

    // Only the time-bucketed charts have a grain to choose. Showing the toggle on the capacity
    // tab, where every point is one cycle, would be a control that does nothing — and the
    // energy tab is all-monthly now, so it lost the pill too.
    const showGranularity = tab === 'usage' || tab === 'electrical';

    return (
        <div className="space-y-6">
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500">
                    <BatteryCharging className="w-4 h-4 text-gray-400" /> Battery
                </span>
                <BatteryPicker value={battery} onChange={setBattery} options={batteries} />

                <div className="flex flex-wrap items-center gap-2 ml-auto">
                    <PeriodFilterBar period={period} showGranularity={showGranularity} />
                    <ExportChargingAnalysis
                        battery={battery}
                        periodParam={period.periodParam}
                        fileSuffix={period.fileSuffix}
                    />
                </div>
            </div>

            {!battery ? (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center text-gray-400 text-sm">
                    <BatteryCharging className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                    Select a battery to view its analytics.
                </div>
            ) : (
                <>
                    <div className="space-y-2">
                        <BatteryStatCards summary={ah?.summary} plottedCycles={plottedCycles} />
                        <CadenceReadout cadence={cadence} />
                    </div>

                    <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl overflow-x-auto">
                        {SUB_TABS.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTab(t.id)}
                                className={cn(
                                    'px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap',
                                    tab === t.id
                                        ? 'bg-white text-brand-700 shadow-sm'
                                        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50',
                                )}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>

                    {tab === 'capacity' && (
                        ahLoading && !ah ? (
                            <ChartFallback />
                        ) : (
                            <div className="space-y-6">
                                <CapacityDegradationChart
                                    sessions={sessions}
                                    summary={ah?.summary}
                                    periodLabel={period.periodLabel}
                                    thresholds={thresholds}
                                />
                                <CapacityByPeriodChart
                                    sessions={sessions}
                                    summary={ah?.summary}
                                    granularity="month"
                                    thresholds={thresholds}
                                />
                            </div>
                        )
                    )}

                    {tab === 'energy' && (
                        <div className="space-y-6">
                            <MonthlyEnergyDistanceChart energy={energyMonthly} distance={distanceMonthly} />
                            <DeepDischargeChart
                                byMonth={deep?.byMonth ?? []}
                                enterPct={deep?.gates.deepEnterPct ?? 20}
                                exitPct={deep?.gates.deepExitPct ?? 25}
                                totalEvents={deep?.events.length ?? 0}
                            />
                        </div>
                    )}

                    {tab === 'usage' && (
                        <div className="space-y-6">
                            <DriverBehaviourCards data={distance} />
                            <DistanceTrendChart data={distance} granularity={period.granularity} />
                            <DischargeVsKmChart data={km} />
                            <AhVsMileageChart data={km} />
                            <MileageTrendChart data={km} />
                            <PerCycleMileageChart data={km} />
                        </div>
                    )}

                    {tab === 'location' && <LocationMap data={geo} />}

                    {tab === 'electrical' && (
                        <div className="space-y-6">
                            <RedFlagCards data={electrical} />
                            <VoltageTrendChart data={electrical} granularity={period.granularity} />
                            <CurrentTrendChart data={electrical} granularity={period.granularity} />
                        </div>
                    )}

                    {tab === 'timeline' && (
                        <ChargingTimeline
                            timeline={timeline}
                            chargeCycles={sessions}
                            dischargeCycles={discharge?.cycles ?? []}
                            battery={battery}
                        />
                    )}
                </>
            )}
        </div>
    );
}

// Local alias: the energy payload's name collides with the DOM's EnergyData in lib.dom.
type EnergyDataT = import('./types').EnergyData;
