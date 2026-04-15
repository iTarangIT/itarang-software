'use client';

import { useState } from 'react';
import {
    Battery, Search, Filter, Zap, ThermometerSun,
    Activity, AlertTriangle, CheckCircle2, MapPin,
    RefreshCw, Smartphone, BarChart3, Bell, Wrench,
} from 'lucide-react';

type BatteryUnit = {
    id: string;
    serial_number: string;
    model: string;
    capacity_ah: number;
    voltage: number;
    soc_percent: number;
    health_percent: number;
    temperature_c: number;
    cycle_count: number;
    status: 'active' | 'idle' | 'charging' | 'maintenance' | 'decommissioned';
    deployed_to: string | null;
    location: string;
    last_ping: string;
};

const MOCK_BATTERIES: BatteryUnit[] = [
    {
        id: 'BAT-0001', serial_number: 'IT48-30-A0421', model: 'iTarang 48V 30Ah',
        capacity_ah: 30, voltage: 48, soc_percent: 87, health_percent: 96,
        temperature_c: 32, cycle_count: 142, status: 'active',
        deployed_to: 'Rajesh Kumar', location: 'Pune, MH', last_ping: '2026-04-08T00:15:00Z',
    },
    {
        id: 'BAT-0002', serial_number: 'IT60-24-B0318', model: 'iTarang 60V 24Ah',
        capacity_ah: 24, voltage: 60, soc_percent: 45, health_percent: 89,
        temperature_c: 28, cycle_count: 310, status: 'active',
        deployed_to: 'Sunil Patil', location: 'Nashik, MH', last_ping: '2026-04-07T22:30:00Z',
    },
    {
        id: 'BAT-0003', serial_number: 'IT48-30-A0422', model: 'iTarang 48V 30Ah',
        capacity_ah: 30, voltage: 48, soc_percent: 100, health_percent: 99,
        temperature_c: 25, cycle_count: 12, status: 'charging',
        deployed_to: null, location: 'Warehouse A', last_ping: '2026-04-08T00:20:00Z',
    },
    {
        id: 'BAT-0004', serial_number: 'IT72-40-C0102', model: 'iTarang 72V 40Ah',
        capacity_ah: 40, voltage: 72, soc_percent: 22, health_percent: 71,
        temperature_c: 38, cycle_count: 520, status: 'maintenance',
        deployed_to: 'Amit Deshmukh', location: 'Service Center', last_ping: '2026-04-06T14:00:00Z',
    },
    {
        id: 'BAT-0005', serial_number: 'IT48-30-A0423', model: 'iTarang 48V 30Ah',
        capacity_ah: 30, voltage: 48, soc_percent: 63, health_percent: 93,
        temperature_c: 30, cycle_count: 198, status: 'active',
        deployed_to: 'Priya Sharma', location: 'Mumbai, MH', last_ping: '2026-04-08T00:05:00Z',
    },
    {
        id: 'BAT-0006', serial_number: 'IT60-24-B0319', model: 'iTarang 60V 24Ah',
        capacity_ah: 24, voltage: 60, soc_percent: 0, health_percent: 42,
        temperature_c: 24, cycle_count: 780, status: 'decommissioned',
        deployed_to: null, location: 'Warehouse B', last_ping: '2026-03-20T10:00:00Z',
    },
];

const STATUS_FILTERS = ['all', 'active', 'charging', 'idle', 'maintenance', 'decommissioned'] as const;

export default function BatteryManagementPage() {
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');

    const batteries = MOCK_BATTERIES.filter(b => {
        if (statusFilter !== 'all' && b.status !== statusFilter) return false;
        if (search && !b.serial_number.toLowerCase().includes(search.toLowerCase()) && !b.model.toLowerCase().includes(search.toLowerCase()) && !(b.deployed_to || '').toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const totalActive = MOCK_BATTERIES.filter(b => b.status === 'active').length;
    const avgHealth = Math.round(MOCK_BATTERIES.reduce((s, b) => s + b.health_percent, 0) / MOCK_BATTERIES.length);
    const needsMaintenance = MOCK_BATTERIES.filter(b => b.health_percent < 75 || b.status === 'maintenance').length;
    const avgSoc = Math.round(MOCK_BATTERIES.filter(b => b.status !== 'decommissioned').reduce((s, b) => s + b.soc_percent, 0) / MOCK_BATTERIES.filter(b => b.status !== 'decommissioned').length);

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Battery Management</h1>
                    <p className="mt-1 text-gray-500">Monitor battery health, charge levels, and lifecycle across your fleet.</p>
                </div>
                <button className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors">
                    <RefreshCw className="h-4 w-4" /> Sync Telemetry
                </button>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard icon={<Battery className="h-5 w-5" />} title="Active" value={totalActive} subtitle="deployed" tone="green" />
                <KpiCard icon={<Activity className="h-5 w-5" />} title="Avg Health" value={`${avgHealth}%`} subtitle="fleet-wide" tone="blue" />
                <KpiCard icon={<Zap className="h-5 w-5" />} title="Avg SoC" value={`${avgSoc}%`} subtitle="charge level" tone="indigo" />
                <KpiCard icon={<Wrench className="h-5 w-5" />} title="Needs Service" value={needsMaintenance} subtitle="attention needed" tone="red" />
            </div>

            {/* Search & Filter */}
            <div className="flex flex-col md:flex-row gap-3">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                        type="text"
                        placeholder="Search by serial, model, or customer..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                    />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <Filter className="h-4 w-4 text-gray-400" />
                    {STATUS_FILTERS.map(f => (
                        <button
                            key={f}
                            onClick={() => setStatusFilter(f)}
                            className={`px-3 py-1.5 rounded-full text-xs font-semibold border capitalize transition-colors ${statusFilter === f ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                        >
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            {/* Battery Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {batteries.map(bat => (
                    <div key={bat.id} className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <div className="font-bold text-gray-900">{bat.model}</div>
                                <div className="text-xs text-gray-400 font-mono">{bat.serial_number}</div>
                            </div>
                            <BatteryStatusBadge status={bat.status} />
                        </div>

                        {/* Battery gauge */}
                        <div className="mb-4">
                            <div className="flex items-center justify-between text-xs mb-1">
                                <span className="text-gray-500">State of Charge</span>
                                <span className="font-bold text-gray-900">{bat.soc_percent}%</span>
                            </div>
                            <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${bat.soc_percent > 60 ? 'bg-green-500' : bat.soc_percent > 25 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                    style={{ width: `${bat.soc_percent}%` }}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 text-center mb-4">
                            <div className="rounded-lg bg-gray-50 px-2 py-2">
                                <div className="text-xs text-gray-400">Health</div>
                                <div className={`text-sm font-bold ${bat.health_percent > 80 ? 'text-green-700' : bat.health_percent > 60 ? 'text-yellow-700' : 'text-red-700'}`}>
                                    {bat.health_percent}%
                                </div>
                            </div>
                            <div className="rounded-lg bg-gray-50 px-2 py-2">
                                <div className="text-xs text-gray-400">Temp</div>
                                <div className={`text-sm font-bold ${bat.temperature_c > 35 ? 'text-red-700' : 'text-gray-900'}`}>
                                    {bat.temperature_c}°C
                                </div>
                            </div>
                            <div className="rounded-lg bg-gray-50 px-2 py-2">
                                <div className="text-xs text-gray-400">Cycles</div>
                                <div className="text-sm font-bold text-gray-900">{bat.cycle_count}</div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 text-xs text-gray-500">
                            <MapPin className="h-3 w-3" />
                            {bat.deployed_to ? `${bat.deployed_to} · ${bat.location}` : bat.location}
                        </div>
                    </div>
                ))}
            </div>

            {batteries.length === 0 && (
                <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-sm text-gray-500 shadow-sm">
                    No batteries found for this filter.
                </div>
            )}

            {/* Future Roadmap */}
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-6">
                <div className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-3">Coming Soon</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <FutureItem icon={<Smartphone className="h-4 w-4" />} text="Live GPS tracking with IntelliCar integration" />
                    <FutureItem icon={<BarChart3 className="h-4 w-4" />} text="Predictive health analytics & replacement forecasting" />
                    <FutureItem icon={<Bell className="h-4 w-4" />} text="Automated alerts for overheating, low SoC, and SoH degradation" />
                    <FutureItem icon={<Wrench className="h-4 w-4" />} text="One-click service ticket creation from battery card" />
                </div>
            </div>
        </div>
    );
}

function KpiCard({ icon, title, value, subtitle, tone }: { icon: React.ReactNode; title: string; value: string | number; subtitle: string; tone: string }) {
    const colors: Record<string, string> = { green: 'bg-green-50 text-green-600', blue: 'bg-blue-50 text-blue-600', indigo: 'bg-indigo-50 text-indigo-600', red: 'bg-red-50 text-red-600' };
    return (
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
                <div className={`rounded-xl p-2 ${colors[tone]}`}>{icon}</div>
                <div>
                    <div className="text-2xl font-extrabold text-gray-900">{value}</div>
                    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</div>
                </div>
            </div>
            <div className="text-[10px] text-gray-400 mt-1 ml-12">{subtitle}</div>
        </div>
    );
}

function BatteryStatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        active: 'bg-green-50 text-green-700',
        charging: 'bg-blue-50 text-blue-700',
        idle: 'bg-gray-100 text-gray-600',
        maintenance: 'bg-yellow-50 text-yellow-700',
        decommissioned: 'bg-red-50 text-red-700',
    };
    return (
        <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-semibold capitalize ${map[status] || 'bg-gray-100 text-gray-600'}`}>
            {status}
        </span>
    );
}

function FutureItem({ icon, text }: { icon: React.ReactNode; text: string }) {
    return (
        <div className="flex items-start gap-2 text-sm text-gray-600">
            <div className="mt-0.5 text-gray-400">{icon}</div>
            <span>{text}</span>
        </div>
    );
}
