'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertTriangle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export function TripAnalytics() {
    const { data: socData, isLoading: socLoading } = useQuery({
        queryKey: ['intellicar-soc-trends'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/analytics/soc-trends?days=30');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    const { data: tripsData, isLoading: tripsLoading } = useQuery({
        queryKey: ['intellicar-trips-overview'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/trips/overview?limit=50');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    if (socLoading || tripsLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-brand-600 animate-spin" /></div>;
    }

    const socChartData = Array.isArray(socData) ? socData : [];
    const trips = Array.isArray(tripsData) ? tripsData : [];

    return (
        <div className="space-y-6">
            {/* SOC Trends Chart */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">SOC Trends (30 Days)</h3>
                {socChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={socChartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                            <Tooltip />
                            <Legend />
                            <Line type="monotone" dataKey="avg_soc" name="Avg SOC" stroke="#3b82f6" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="min_soc" name="Min SOC" stroke="#ef4444" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                            <Line type="monotone" dataKey="max_soc" name="Max SOC" stroke="#22c55e" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <div className="h-48 flex items-center justify-center text-gray-400 text-sm">No SOC data available</div>
                )}
            </div>

            {/* Trip History */}
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
                            {trips.length === 0 ? (
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
