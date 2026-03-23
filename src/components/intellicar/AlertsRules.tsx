'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Loader2, Check, AlertTriangle, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AlertsRules() {
    const queryClient = useQueryClient();

    const { data: alerts, isLoading: alertsLoading } = useQuery({
        queryKey: ['intellicar-alerts'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/alerts?limit=50&acknowledged=false');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    const { data: config, isLoading: configLoading } = useQuery({
        queryKey: ['intellicar-alert-config'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/alerts/config');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    const ackMutation = useMutation({
        mutationFn: async (alertId: string) => {
            const res = await fetch('/api/telemetry/alerts/acknowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alertId }),
            });
            if (!res.ok) throw new Error('Failed');
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['intellicar-alerts'] }),
    });

    if (alertsLoading || configLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-brand-600 animate-spin" /></div>;
    }

    const alertList = Array.isArray(alerts) ? alerts : [];
    const configList = Array.isArray(config) ? config : [];

    return (
        <div className="space-y-6">
            {/* Active Alerts */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                        <Bell className="w-4 h-4 text-red-500" /> Active Alerts
                    </h3>
                    <span className="text-xs text-gray-500">{alertList.length} unacknowledged</span>
                </div>
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-white">
                            <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                                <th className="px-4 py-3 font-medium">Severity</th>
                                <th className="px-4 py-3 font-medium">Type</th>
                                <th className="px-4 py-3 font-medium">Device</th>
                                <th className="px-4 py-3 font-medium">Message</th>
                                <th className="px-4 py-3 font-medium">Time</th>
                                <th className="px-4 py-3 font-medium">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {alertList.length === 0 ? (
                                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No active alerts</td></tr>
                            ) : alertList.map((a: Record<string, unknown>, i: number) => (
                                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                                    <td className="px-4 py-3">
                                        <SeverityBadge severity={String(a.severity || 'info')} />
                                    </td>
                                    <td className="px-4 py-3 font-medium text-gray-900 text-xs">{String(a.alert_type || '-')}</td>
                                    <td className="px-4 py-3 text-gray-600 text-xs">{String(a.device_id || '-')}</td>
                                    <td className="px-4 py-3 text-gray-600 text-xs max-w-xs truncate">{String(a.message || '-')}</td>
                                    <td className="px-4 py-3 text-gray-500 text-xs">{a.created_at ? new Date(String(a.created_at)).toLocaleString() : '-'}</td>
                                    <td className="px-4 py-3">
                                        <button
                                            onClick={() => ackMutation.mutate(String(a.id))}
                                            disabled={ackMutation.isPending}
                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-50 rounded-lg hover:bg-green-100"
                                        >
                                            <Check className="w-3 h-3" /> Ack
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Alert Configuration */}
            {configList.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                    <div className="p-4 border-b border-gray-100">
                        <h3 className="text-sm font-semibold text-gray-900">Alert Threshold Configuration</h3>
                    </div>
                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {configList.map((c: Record<string, unknown>, i: number) => (
                            <AlertConfigCard key={i} config={c} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function SeverityBadge({ severity }: { severity: string }) {
    const colors: Record<string, string> = {
        critical: 'bg-red-100 text-red-700',
        warning: 'bg-amber-100 text-amber-700',
        info: 'bg-blue-100 text-blue-700',
    };
    return (
        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', colors[severity] || colors.info)}>
            <AlertTriangle className="w-3 h-3" />
            {severity}
        </span>
    );
}

function AlertConfigCard({ config }: { config: Record<string, unknown> }) {
    const [editing, setEditing] = useState(false);
    const [threshold, setThreshold] = useState(String(config.threshold_value || ''));
    const queryClient = useQueryClient();

    const saveMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch('/api/telemetry/alerts/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    alert_type: config.alert_type,
                    threshold: Number(threshold),
                    severity: config.severity,
                }),
            });
            if (!res.ok) throw new Error('Failed');
        },
        onSuccess: () => {
            setEditing(false);
            queryClient.invalidateQueries({ queryKey: ['intellicar-alert-config'] });
        },
    });

    return (
        <div className="p-3 border border-gray-100 rounded-lg">
            <p className="text-xs font-semibold text-gray-900 mb-1">{String(config.alert_type || '').replace(/_/g, ' ').toUpperCase()}</p>
            <p className="text-xs text-gray-500 mb-2">Severity: {String(config.severity || '-')}</p>
            {editing ? (
                <div className="flex items-center gap-2">
                    <input
                        type="number"
                        value={threshold}
                        onChange={(e) => setThreshold(e.target.value)}
                        className="w-20 px-2 py-1 text-xs border border-gray-200 rounded"
                    />
                    <button onClick={() => saveMutation.mutate()} className="text-xs text-brand-600 font-medium">Save</button>
                    <button onClick={() => setEditing(false)} className="text-xs text-gray-400">Cancel</button>
                </div>
            ) : (
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-gray-900">{String(config.threshold_value || '-')}</span>
                    <button onClick={() => setEditing(true)} className="text-xs text-brand-600 font-medium">Edit</button>
                </div>
            )}
        </div>
    );
}
