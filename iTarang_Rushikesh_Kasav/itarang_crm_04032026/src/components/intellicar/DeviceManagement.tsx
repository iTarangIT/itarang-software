'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Loader2, Plus, Upload, Wifi, WifiOff, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export function DeviceManagement() {
    const queryClient = useQueryClient();
    const [showAdd, setShowAdd] = useState(false);

    const { data: devices, isLoading } = useQuery({
        queryKey: ['intellicar-devices'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/devices?limit=100');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    const { data: statusData } = useQuery({
        queryKey: ['intellicar-device-status'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/devices/status');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
        refetchInterval: 30000,
    });

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-brand-600 animate-spin" /></div>;
    }

    const deviceList = Array.isArray(devices) ? devices : [];
    const statusList = Array.isArray(statusData) ? statusData : [];
    const statusMap = new Map(statusList.map((s: Record<string, unknown>) => [s.device_id, s.comm_status]));

    return (
        <div className="space-y-6">
            {/* Actions */}
            <div className="flex items-center gap-3">
                <button
                    onClick={() => setShowAdd(!showAdd)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700"
                >
                    <Plus className="w-4 h-4" /> Add Device
                </button>
                <BulkImportButton />
            </div>

            {/* Add Device Form */}
            {showAdd && <AddDeviceForm onClose={() => setShowAdd(false)} />}

            {/* Device Table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">Device Mappings</h3>
                    <span className="text-xs text-gray-500">{deviceList.length} devices</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                                <th className="px-4 py-3 font-medium">Device ID</th>
                                <th className="px-4 py-3 font-medium">Battery Serial</th>
                                <th className="px-4 py-3 font-medium">Vehicle</th>
                                <th className="px-4 py-3 font-medium">Customer</th>
                                <th className="px-4 py-3 font-medium">Dealer</th>
                                <th className="px-4 py-3 font-medium">SOC</th>
                                <th className="px-4 py-3 font-medium">SOH</th>
                                <th className="px-4 py-3 font-medium">Comm Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {deviceList.length === 0 ? (
                                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No devices</td></tr>
                            ) : deviceList.map((d: Record<string, unknown>, i: number) => (
                                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                                    <td className="px-4 py-3 font-medium text-gray-900 text-xs">{String(d.device_id || '-')}</td>
                                    <td className="px-4 py-3 text-gray-600 text-xs">{String(d.battery_serial || '-')}</td>
                                    <td className="px-4 py-3 text-gray-600 text-xs">{String(d.vehicle_number || '-')}</td>
                                    <td className="px-4 py-3 text-gray-600 text-xs">{String(d.customer_name || '-')}</td>
                                    <td className="px-4 py-3 text-gray-600 text-xs">{String(d.dealer_id || '-')}</td>
                                    <td className="px-4 py-3">
                                        <span className={cn('font-medium text-xs', Number(d.soc) > 50 ? 'text-green-600' : 'text-amber-600')}>
                                            {d.soc != null ? `${d.soc}%` : '-'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className={cn('font-medium text-xs', Number(d.soh) > 80 ? 'text-green-600' : 'text-amber-600')}>
                                            {d.soh != null ? `${d.soh}%` : '-'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3">
                                        <CommStatusBadge status={String(statusMap.get(d.device_id) || 'unknown')} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

function CommStatusBadge({ status }: { status: string }) {
    const config: Record<string, { icon: React.ElementType; color: string }> = {
        online: { icon: Wifi, color: 'text-green-600' },
        intermittent: { icon: Clock, color: 'text-amber-600' },
        offline: { icon: WifiOff, color: 'text-gray-400' },
        unknown: { icon: WifiOff, color: 'text-gray-300' },
    };
    const c = config[status] || config.unknown;
    return (
        <span className={cn('inline-flex items-center gap-1 text-xs font-medium', c.color)}>
            <c.icon className="w-3 h-3" /> {status}
        </span>
    );
}

function AddDeviceForm({ onClose }: { onClose: () => void }) {
    const queryClient = useQueryClient();
    const [form, setForm] = useState({ device_id: '', battery_serial: '', vehicle_number: '', customer_name: '', dealer_id: '' });

    const mutation = useMutation({
        mutationFn: async () => {
            const res = await fetch('/api/telemetry/devices/mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            if (!res.ok) throw new Error('Failed');
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['intellicar-devices'] });
            onClose();
        },
    });

    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Add Device Mapping</h4>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {(['device_id', 'battery_serial', 'vehicle_number', 'customer_name', 'dealer_id'] as const).map((f) => (
                    <input
                        key={f}
                        placeholder={f.replace(/_/g, ' ')}
                        value={form[f]}
                        onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                        className="px-3 py-2 text-sm border border-gray-200 rounded-lg"
                    />
                ))}
            </div>
            <div className="flex gap-2 mt-3">
                <button onClick={() => mutation.mutate()} disabled={!form.device_id || mutation.isPending} className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50">
                    {mutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
            </div>
        </div>
    );
}

function BulkImportButton() {
    const queryClient = useQueryClient();
    const [uploading, setUploading] = useState(false);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        try {
            const text = await file.text();
            const lines = text.split('\n').filter(Boolean);
            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            const mappings = lines.slice(1).map(line => {
                const vals = line.split(',').map(v => v.trim());
                const obj: Record<string, string> = {};
                headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
                return obj;
            });

            await fetch('/api/telemetry/devices/mapping/bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mappings }),
            });
            queryClient.invalidateQueries({ queryKey: ['intellicar-devices'] });
        } catch (err) {
            console.error('Bulk import error:', err);
        } finally {
            setUploading(false);
        }
    };

    return (
        <label className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 cursor-pointer">
            <Upload className="w-4 h-4" />
            {uploading ? 'Importing...' : 'Bulk Import CSV'}
            <input type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
        </label>
    );
}
