'use client';

import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Battery, Activity, AlertTriangle, Wifi, WifiOff, Loader2, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FleetLocations {
    states: string[];
    citiesByState: Record<string, string[]>;
}

const PAGE_SIZE = 50;

interface KPI {
    label: string;
    value: string | number;
    icon: React.ElementType;
    color: string;
}

interface FleetEnvelope<T> {
    data: T;
    degraded?: boolean;
    reason?: string;
}

export function FleetOverview() {
    const [selectedState, setSelectedState] = useState('');
    const [selectedCity, setSelectedCity] = useState('');
    const [page, setPage] = useState(1);

    const { data: locations } = useQuery<FleetLocations>({
        queryKey: ['intellicar-fleet-locations'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/fleet/locations');
            if (!res.ok) throw new Error('Failed to fetch locations');
            return (await res.json()).data as FleetLocations;
        },
    });

    const filterQs = new URLSearchParams();
    if (selectedState) filterQs.set('state', selectedState);
    if (selectedCity) filterQs.set('city', selectedCity);
    const suffix = filterQs.toString() ? `?${filterQs.toString()}` : '';

    const { data: envelope, isLoading, error } = useQuery<FleetEnvelope<unknown>>({
        queryKey: ['intellicar-fleet-dashboard', selectedState, selectedCity],
        queryFn: async () => {
            const res = await fetch(`/api/telemetry/fleet/dashboard${suffix}`);
            if (!res.ok) throw new Error('Failed to fetch fleet data');
            const json = await res.json();
            return { data: json.data, degraded: json.degraded, reason: json.reason };
        },
        refetchInterval: 60000,
        placeholderData: keepPreviousData,
    });

    const { data: mapEnvelope } = useQuery<FleetEnvelope<unknown[]>>({
        queryKey: ['intellicar-fleet-map', selectedState, selectedCity],
        queryFn: async () => {
            const res = await fetch(`/api/telemetry/fleet/map${suffix}`);
            if (!res.ok) throw new Error('Failed to fetch map data');
            const json = await res.json();
            return { data: json.data, degraded: json.degraded, reason: json.reason };
        },
        refetchInterval: 30000,
        placeholderData: keepPreviousData,
    });

    const data = envelope?.data as {
        kpis?: Record<string, number>;
        dealerPerformance?: Array<Record<string, unknown>>;
        serviceMetrics?: { fleetUptime: number; avgDailyDistance: number; offlineDevices: number };
    } | undefined;
    const mapData = mapEnvelope?.data;
    const degraded = Boolean(envelope?.degraded || mapEnvelope?.degraded);
    const degradedReason = envelope?.reason ?? mapEnvelope?.reason ?? '';

    const stateOptions = locations?.states ?? [];
    const cityOptions = selectedState ? locations?.citiesByState[selectedState] ?? [] : [];

    const changeState = (value: string) => {
        setSelectedState(value);
        setSelectedCity('');
        setPage(1);
    };
    const changeCity = (value: string) => {
        setSelectedCity(value);
        setPage(1);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-6 bg-red-50 rounded-xl text-center">
                <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
                <p className="text-sm text-red-700">Failed to load fleet data. Check the server logs for the underlying error.</p>
            </div>
        );
    }

    const kpis = data?.kpis || {};
    const kpiCards: KPI[] = [
        { label: 'Fleet Size', value: kpis.fleetSize || 0, icon: Battery, color: 'text-blue-600' },
        { label: 'Utilization %', value: `${kpis.utilization || 0}%`, icon: Activity, color: 'text-green-600' },
        { label: 'Avg SOH %', value: `${kpis.avgSOH || 0}%`, icon: Battery, color: 'text-purple-600' },
        { label: 'Warranty At-Risk', value: kpis.warrantyAtRisk || 0, icon: AlertTriangle, color: 'text-amber-600' },
        { label: 'Active Alerts', value: kpis.activeAlerts || 0, icon: AlertTriangle, color: 'text-red-600' },
    ];

    const devices = Array.isArray(mapData) ? mapData : [];
    const totalPages = Math.max(1, Math.ceil(devices.length / PAGE_SIZE));
    const currentPage = Math.min(page, totalPages);
    const pageDevices = devices.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    const rangeStart = devices.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
    const rangeEnd = Math.min(currentPage * PAGE_SIZE, devices.length);

    return (
        <div className="space-y-6">
            {/* State / City filters */}
            <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500">
                    <MapPin className="w-4 h-4 text-gray-400" /> Filter
                </span>
                <select
                    value={selectedState}
                    onChange={(e) => changeState(e.target.value)}
                    className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-200"
                >
                    <option value="">All States</option>
                    {stateOptions.map((s) => (
                        <option key={s} value={s}>{s}</option>
                    ))}
                </select>
                <select
                    value={selectedCity}
                    onChange={(e) => changeCity(e.target.value)}
                    disabled={!selectedState || cityOptions.length === 0}
                    className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <option value="">All Cities</option>
                    {cityOptions.map((c) => (
                        <option key={c} value={c}>{c}</option>
                    ))}
                </select>
                {(selectedState || selectedCity) && (
                    <button
                        type="button"
                        onClick={() => changeState('')}
                        className="text-xs font-medium text-brand-600 hover:underline"
                    >
                        Clear
                    </button>
                )}
            </div>

            {degraded ? (
                <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-none text-amber-600" />
                    <p>{degradedReason || 'IoT VPS unreachable — fleet KPIs show zeros until the tunnel is up.'}</p>
                </div>
            ) : null}

            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {kpiCards.map((kpi) => (
                    <div key={kpi.label} className="p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
                        <div className="flex items-center gap-2 mb-2">
                            <kpi.icon className={cn('w-4 h-4', kpi.color)} />
                            <span className="text-xs font-medium text-gray-500">{kpi.label}</span>
                        </div>
                        <p className="text-2xl font-bold text-gray-900">{kpi.value}</p>
                    </div>
                ))}
            </div>

            {/* Fleet Device List (replaces map) */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">Fleet Devices</h3>
                    <span className="text-xs text-gray-500">{devices.length} devices</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                                <th className="px-4 py-3 font-medium">Device</th>
                                <th className="px-4 py-3 font-medium">Vehicle</th>
                                <th className="px-4 py-3 font-medium">SOC</th>
                                <th className="px-4 py-3 font-medium">SOH</th>
                                <th className="px-4 py-3 font-medium">Status</th>
                                <th className="px-4 py-3 font-medium">Location</th>
                            </tr>
                        </thead>
                        <tbody>
                            {devices.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-4 py-8 text-center text-gray-400">No devices found</td>
                                </tr>
                            ) : (
                                pageDevices.map((d: Record<string, unknown>, i: number) => (
                                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                                        <td className="px-4 py-3 font-medium text-gray-900">{String(d.device_id || '-')}</td>
                                        <td className="px-4 py-3 text-gray-600">{String(d.vehicle_number || '-')}</td>
                                        <td className="px-4 py-3">
                                            <span className={cn('font-medium', Number(d.soc) > 50 ? 'text-green-600' : Number(d.soc) > 20 ? 'text-amber-600' : 'text-red-600')}>
                                                {d.soc != null ? `${d.soc}%` : '-'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={cn('font-medium', Number(d.soh) > 80 ? 'text-green-600' : Number(d.soh) > 60 ? 'text-amber-600' : 'text-red-600')}>
                                                {d.soh != null ? `${d.soh}%` : '-'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <StatusBadge status={String(d.status || 'offline')} />
                                        </td>
                                        <td className="px-4 py-3 text-gray-500 text-xs">
                                            {d.latitude && d.longitude ? `${Number(d.latitude).toFixed(4)}, ${Number(d.longitude).toFixed(4)}` : 'N/A'}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
                {devices.length > PAGE_SIZE && (
                    <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                        <span>
                            Showing {rangeStart}&ndash;{rangeEnd} of {devices.length}
                        </span>
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setPage((p) => Math.max(1, p - 1))}
                                disabled={currentPage === 1}
                                className="px-3 py-1 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                Prev
                            </button>
                            <span className="text-gray-600">
                                Page {currentPage} of {totalPages}
                            </span>
                            <button
                                type="button"
                                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                disabled={currentPage === totalPages}
                                className="px-3 py-1 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Dealer Performance */}
            {data?.dealerPerformance && Array.isArray(data.dealerPerformance) && data.dealerPerformance.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                    <div className="p-4 border-b border-gray-100">
                        <h3 className="text-sm font-semibold text-gray-900">Dealer Performance</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                                    <th className="px-4 py-3 font-medium">Dealer</th>
                                    <th className="px-4 py-3 font-medium">Devices</th>
                                    <th className="px-4 py-3 font-medium">Avg SOH</th>
                                    <th className="px-4 py-3 font-medium">Alerts</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.dealerPerformance.map((dp: Record<string, unknown>, i: number) => (
                                    <tr key={i} className="border-b border-gray-50">
                                        <td className="px-4 py-3 font-medium text-gray-900">{String(dp.dealer_id || '-')}</td>
                                        <td className="px-4 py-3">{String(dp.device_count || 0)}</td>
                                        <td className="px-4 py-3">{String(dp.avg_soh || 0)}%</td>
                                        <td className="px-4 py-3">{String(dp.alert_count || 0)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Service Metrics */}
            {data?.serviceMetrics && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <MetricCard label="Fleet Uptime" value={`${data.serviceMetrics.fleetUptime}%`} />
                    <MetricCard label="Avg Daily Distance" value={`${data.serviceMetrics.avgDailyDistance} km`} />
                    <MetricCard label="Offline Devices" value={String(data.serviceMetrics.offlineDevices)} />
                </div>
            )}
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const config: Record<string, { label: string; color: string; icon: React.ElementType }> = {
        healthy: { label: 'Healthy', color: 'bg-green-100 text-green-700', icon: Wifi },
        disconnected: { label: 'Battery Offline', color: 'bg-orange-100 text-orange-700', icon: WifiOff },
        warning: { label: 'Warning', color: 'bg-amber-100 text-amber-700', icon: AlertTriangle },
        critical: { label: 'Critical', color: 'bg-red-100 text-red-700', icon: AlertTriangle },
        offline: { label: 'Offline', color: 'bg-gray-100 text-gray-600', icon: WifiOff },
    };
    const c = config[status] || config.offline;
    return (
        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', c.color)}>
            <c.icon className="w-3 h-3" />
            {c.label}
        </span>
    );
}

function MetricCard({ label, value }: { label: string; value: string }) {
    return (
        <div className="p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
            <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
            <p className="text-lg font-bold text-gray-900">{value}</p>
        </div>
    );
}
