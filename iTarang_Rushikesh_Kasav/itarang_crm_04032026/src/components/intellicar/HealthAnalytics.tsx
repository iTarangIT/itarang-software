'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, BarChart, Bar } from 'recharts';
import { cn } from '@/lib/utils';

export function HealthAnalytics() {
    const { data: sohData, isLoading: sohLoading } = useQuery({
        queryKey: ['intellicar-soh-degradation'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/health/degradation?days=30');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    const { data: warrantyData, isLoading: warrantyLoading } = useQuery({
        queryKey: ['intellicar-warranty-risk'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/analytics/warranty');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    const { data: dealerData, isLoading: dealerLoading } = useQuery({
        queryKey: ['intellicar-dealer-comparison'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/analytics/dealer-comparison');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    if (sohLoading || warrantyLoading || dealerLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-brand-600 animate-spin" /></div>;
    }

    const sohChartData = Array.isArray(sohData) ? sohData : [];
    const warranty = Array.isArray(warrantyData) ? warrantyData : [];
    const dealers = Array.isArray(dealerData) ? dealerData : [];

    return (
        <div className="space-y-6">
            {/* SOH Degradation Chart */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">SOH Degradation (30 Days)</h3>
                {sohChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={sohChartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                            <Tooltip />
                            <Legend />
                            <Line type="monotone" dataKey="avg_soh" name="Avg SOH" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="min_soh" name="Min SOH" stroke="#ef4444" strokeWidth={1} dot={false} strokeDasharray="4 4" />
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
                        <span className="text-xs text-red-600 font-medium">{warranty.length} devices</span>
                    </div>
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
                                    <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-400">No at-risk devices</td></tr>
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
                </div>

                {/* Dealer Comparison Chart */}
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
                    <h3 className="text-sm font-semibold text-gray-900 mb-4">Dealer Comparison</h3>
                    {dealers.length > 0 ? (
                        <ResponsiveContainer width="100%" height={280}>
                            <BarChart data={dealers}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                <XAxis dataKey="dealer_id" tick={{ fontSize: 10 }} />
                                <YAxis tick={{ fontSize: 11 }} />
                                <Tooltip />
                                <Legend />
                                <Bar dataKey="devices" name="Devices" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                                <Bar dataKey="avg_soh" name="Avg SOH" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
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
