'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, BarChart, Bar } from 'recharts';
import { cn } from '@/lib/utils';
import type { SohFeedVerdict, WarrantyAssessment } from '@/lib/telemetry/soh-math';

/**
 * Read a telemetry route, keeping the server's message on failure.
 *
 * The previous `throw new Error('Failed')` discarded it, and every caller then fell
 * through to an `Array.isArray(undefined) → []` guard that rendered "No SOH data
 * available" / "No at-risk devices". A dead VPS was indistinguishable from a healthy
 * fleet — the one confusion this page must never make.
 */
async function readTelemetry<T>(url: string): Promise<T> {
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.success === false) {
        throw new Error(body?.error?.message || `Request failed (${res.status})`);
    }
    return body?.data as T;
}

/** A panel whose query failed. Never silently an empty state. */
function PanelError({ message }: { message: string }) {
    return (
        <div className="h-48 flex flex-col items-center justify-center gap-2 text-center px-4">
            <AlertTriangle className="w-5 h-5 text-red-500" />
            <p className="text-sm font-medium text-red-600">Could not load this data</p>
            <p className="text-xs text-gray-500 max-w-md">{message}</p>
        </div>
    );
}

/**
 * The BMS reported a State of Health, but the same one for every pack — so it is not a
 * measurement and must not be drawn as one.
 */
function StuckFeedNotice({ value, detail }: { value: number | null; detail: string }) {
    return (
        <div className="h-48 flex flex-col items-center justify-center gap-2 text-center px-4">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            <p className="text-sm font-medium text-gray-900">
                State of Health is not being measured
            </p>
            <p className="text-xs text-gray-500 max-w-lg leading-relaxed">
                {value != null && (
                    <>Every reporting pack returns exactly {value}%. </>
                )}
                {detail} A value that never varies describes the BMS default, not the
                battery, so it is withheld rather than charted. Measured capacity is
                available per battery under Battery Analytics.
            </p>
        </div>
    );
}

interface SohPayload {
    trend: Array<Record<string, unknown>>;
    verdict: SohFeedVerdict;
}
interface WarrantyPayload {
    devices: Array<Record<string, unknown>>;
    assessment: WarrantyAssessment;
}

export function HealthAnalytics() {
    const { data: sohData, isLoading: sohLoading, error: sohError } = useQuery({
        queryKey: ['intellicar-soh-degradation'],
        queryFn: () => readTelemetry<SohPayload>('/api/telemetry/health/degradation?days=30'),
    });

    const { data: warrantyData, isLoading: warrantyLoading, error: warrantyError } = useQuery({
        queryKey: ['intellicar-warranty-risk'],
        queryFn: () => readTelemetry<WarrantyPayload>('/api/telemetry/analytics/warranty'),
    });

    const { data: dealerData, isLoading: dealerLoading, error: dealerError } = useQuery({
        queryKey: ['intellicar-dealer-comparison'],
        queryFn: () => readTelemetry<Array<Record<string, unknown>>>('/api/telemetry/analytics/dealer-comparison'),
    });

    if (sohLoading || warrantyLoading || dealerLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-brand-600 animate-spin" /></div>;
    }

    const sohChartData = Array.isArray(sohData?.trend) ? sohData.trend : [];
    const sohVerdict = sohData?.verdict;
    const warranty = Array.isArray(warrantyData?.devices) ? warrantyData.devices : [];
    const assessment = warrantyData?.assessment;
    const dealers = Array.isArray(dealerData) ? dealerData : [];
    const msg = (e: unknown) => (e instanceof Error ? e.message : 'Unknown error');

    return (
        <div className="space-y-6">
            {/* SOH Degradation Chart */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">SOH Degradation (30 Days)</h3>
                {sohError ? (
                    <PanelError message={msg(sohError)} />
                ) : sohVerdict?.kind === 'constant' ? (
                    <StuckFeedNotice
                        value={sohVerdict.value}
                        detail={`Across all ${sohVerdict.days} day${sohVerdict.days === 1 ? '' : 's'} in this window, no pack ever differed from any other.`}
                    />
                ) : sohChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={sohChartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis
                                dataKey="date"
                                tick={{ fontSize: 11 }}
                                // The route serialises a pg `date` to a full ISO timestamp;
                                // without this every tick reads "2026-07-13T00:00:00.000Z".
                                tickFormatter={(d: string) => String(d).slice(0, 10)}
                            />
                            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                            <Tooltip labelFormatter={(d) => String(d).slice(0, 10)} />
                            <Legend />
                            <Line type="monotone" dataKey="avg_soh" name="Avg SOH" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="min_soh" name="Min SOH" stroke="#ef4444" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                            <Line type="monotone" dataKey="max_soh" name="Max SOH" stroke="#10b981" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <div className="h-48 flex items-center justify-center text-gray-400 text-sm">No SOH data available</div>
                )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Warranty Risk Table */}
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                    <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-gray-900">Warranty At-Risk Devices</h3>
                        {/* Only claim a count when the test could actually run. A red "0
                            devices" next to a stuck feed reads as an all-clear. */}
                        {!warrantyError && assessment && !assessment.constantFeed && (
                            <span className="text-xs text-red-600 font-medium">{warranty.length} devices</span>
                        )}
                    </div>
                    {warrantyError ? (
                        <PanelError message={msg(warrantyError)} />
                    ) : assessment?.constantFeed ? (
                        <StuckFeedNotice
                            value={assessment.constantValue}
                            detail={`All ${assessment.assessed} packs reporting an SOH return the same value${assessment.unassessable > 0 ? `, and ${assessment.unassessable} report none at all` : ''}, so the "below 80%" test cannot fire for any of them.`}
                        />
                    ) : (
                    <div className="overflow-x-auto max-h-80 overflow-y-auto">
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-white">
                                <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                                    <th className="px-4 py-3 font-medium">Device</th>
                                    <th className="px-4 py-3 font-medium">Vehicle</th>
                                    <th className="px-4 py-3 font-medium">SOH</th>
                                </tr>
                            </thead>
                            <tbody>
                                {warranty.length === 0 ? (
                                    <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-400">
                                        No pack is below 80%
                                        {assessment ? ` (${assessment.assessed} assessed${assessment.unassessable > 0 ? `, ${assessment.unassessable} unmeasured` : ''})` : ''}
                                    </td></tr>
                                ) : warranty.map((w: Record<string, unknown>, i: number) => (
                                    <tr key={i} className="border-b border-gray-50">
                                        <td className="px-4 py-2 font-medium text-gray-900 text-xs">{String(w.device_id || '-')}</td>
                                        <td className="px-4 py-2 text-gray-600 text-xs">{String(w.vehicle_number || '-')}</td>
                                        <td className="px-4 py-2">
                                            <span className={cn('font-bold text-xs', Number(w.soh) < 60 ? 'text-red-600' : 'text-amber-600')}>
                                                {w.soh != null ? `${w.soh}%` : '-'}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    )}
                </div>

                {/* Dealer Comparison Chart */}
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
                    <h3 className="text-sm font-semibold text-gray-900 mb-4">Dealer Comparison</h3>
                    {dealerError ? (
                        <PanelError message={msg(dealerError)} />
                    ) : dealers.length > 0 ? (
                        <ResponsiveContainer width="100%" height={280}>
                            <BarChart data={dealers}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                <XAxis dataKey="dealer_id" tick={{ fontSize: 10 }} />
                                <YAxis tick={{ fontSize: 11 }} />
                                <Tooltip />
                                <Legend />
                                <Bar dataKey="devices" name="Devices" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                                <Bar dataKey="alerts" name="Alerts" fill="#ef4444" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="h-48 flex items-center justify-center text-gray-400 text-sm">No dealer data available</div>
                    )}
                </div>
            </div>
        </div>
    );
}
