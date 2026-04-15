'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
    Loader2, Search, QrCode, Battery, Wifi, MapPin,
    Wrench, AlertTriangle, CheckCircle2, Filter, Download
} from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';

type DeployedAsset = {
    id: string;
    serial_number: string;
    asset_category: string;
    asset_type: string;
    model_type: string;
    customer_name: string;
    customer_phone: string;
    deployment_date: string;
    deployment_location: string;
    payment_type: string;
    payment_status: string;
    battery_health_percent: string | null;
    last_soc: number | null;
    last_voltage: string | null;
    warranty_status: string;
    status: string;
    qr_code_url: string | null;
    last_maintenance_at: string | null;
    next_maintenance_due: string | null;
};

export default function DeployedAssetsPage() {
    const router = useRouter();
    const { user } = useAuth();
    const [assets, setAssets] = useState<DeployedAsset[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const [filterPayment, setFilterPayment] = useState('all');
    const [filterCategory, setFilterCategory] = useState('all');

    useEffect(() => {
        const fetchAssets = async () => {
            try {
                const params = new URLSearchParams({ status: filterStatus, payment: filterPayment, category: filterCategory, search: searchQuery });
                const res = await fetch(`/api/dealer/assets?${params}`);
                const data = await res.json();
                if (data.success) setAssets(data.data);
            } catch { /* silent */ }
            finally { setLoading(false); }
        };
        fetchAssets();
    }, [filterStatus, filterPayment, filterCategory, searchQuery]);

    const activeAssets = assets.filter(a => a.status === 'active');
    const maintenanceDue = assets.filter(a => a.next_maintenance_due && new Date(a.next_maintenance_due) < new Date());
    const lowBattery = assets.filter(a => a.battery_health_percent && parseFloat(a.battery_health_percent) < 30);

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1400px] mx-auto px-6 py-8">
                <header className="mb-8">
                    <h1 className="text-[28px] font-black text-gray-900 tracking-tight">Deployed Asset Management</h1>
                    <p className="text-sm text-gray-500 mt-1">Track deployed assets, battery health, telemetry, and maintenance</p>
                </header>

                {/* KPI Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                    <KPICard icon={<Battery className="w-5 h-5" />} label="Total Deployed" value={assets.length.toString()} color="blue" />
                    <KPICard icon={<CheckCircle2 className="w-5 h-5" />} label="Active" value={activeAssets.length.toString()} color="green" />
                    <KPICard icon={<Wrench className="w-5 h-5" />} label="Maintenance Due" value={maintenanceDue.length.toString()} color="amber" />
                    <KPICard icon={<AlertTriangle className="w-5 h-5" />} label="Low Battery Health" value={lowBattery.length.toString()} color="red" />
                </div>

                {/* Filters */}
                <div className="flex flex-wrap items-center gap-3 mb-6">
                    <div className="flex gap-2">
                        {['all', 'active', 'maintenance', 'inactive', 'returned'].map(s => (
                            <button key={s} onClick={() => setFilterStatus(s)} className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-all ${filterStatus === s ? 'bg-[#0047AB] text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
                                {s}
                            </button>
                        ))}
                    </div>
                    <div className="h-6 w-px bg-gray-200" />
                    <select value={filterPayment} onChange={e => setFilterPayment(e.target.value)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-bold bg-white text-gray-600">
                        <option value="all">All Payments</option>
                        <option value="upfront">Upfront</option>
                        <option value="finance">Finance</option>
                        <option value="lease">Lease</option>
                    </select>
                    <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-bold bg-white text-gray-600">
                        <option value="all">All Categories</option>
                        <option value="2W">2W</option>
                        <option value="3W">3W</option>
                        <option value="Inverter">Inverter</option>
                    </select>
                    <div className="flex-1" />
                    <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search serial number or customer..." className="pl-10 pr-4 py-2 border border-gray-200 rounded-xl text-sm w-64 outline-none focus:border-[#1D4ED8]" />
                    </div>
                </div>

                {/* Asset Table */}
                <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm overflow-hidden">
                    {loading ? (
                        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-[#1D4ED8]" /></div>
                    ) : assets.length === 0 ? (
                        <div className="text-center py-20 text-gray-400">
                            <Battery className="w-12 h-12 mx-auto mb-3 opacity-30" />
                            <p className="font-bold">No deployed assets found</p>
                        </div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-gray-100 bg-gray-50/50">
                                    <th className="text-left py-4 px-6 font-bold text-gray-500 text-xs uppercase">Asset</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Customer</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Deployed</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Battery</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Payment</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Warranty</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Status</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">QR</th>
                                </tr>
                            </thead>
                            <tbody>
                                {assets.map(asset => (
                                    <tr key={asset.id} className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer">
                                        <td className="py-4 px-6">
                                            <div className="font-bold text-gray-900">{asset.serial_number}</div>
                                            <div className="text-xs text-gray-400">{asset.asset_category} - {asset.model_type}</div>
                                        </td>
                                        <td className="py-4 px-4">
                                            <div className="font-medium">{asset.customer_name}</div>
                                            <div className="text-xs text-gray-400">{asset.customer_phone}</div>
                                        </td>
                                        <td className="py-4 px-4 text-xs text-gray-500">{asset.deployment_date ? new Date(asset.deployment_date).toLocaleDateString() : '-'}</td>
                                        <td className="py-4 px-4">
                                            {asset.battery_health_percent ? (
                                                <div className="flex items-center gap-2">
                                                    <div className="w-12 h-2 bg-gray-100 rounded-full overflow-hidden">
                                                        <div className={`h-full rounded-full ${parseFloat(asset.battery_health_percent) > 50 ? 'bg-green-500' : parseFloat(asset.battery_health_percent) > 20 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${asset.battery_health_percent}%` }} />
                                                    </div>
                                                    <span className="text-xs font-bold">{asset.battery_health_percent}%</span>
                                                </div>
                                            ) : <span className="text-xs text-gray-300">N/A</span>}
                                        </td>
                                        <td className="py-4 px-4 capitalize text-xs">{asset.payment_type}</td>
                                        <td className="py-4 px-4">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${asset.warranty_status === 'active' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                                {asset.warranty_status}
                                            </span>
                                        </td>
                                        <td className="py-4 px-4">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${asset.status === 'active' ? 'bg-green-50 text-green-700' : asset.status === 'maintenance' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                                                {asset.status}
                                            </span>
                                        </td>
                                        <td className="py-4 px-4">
                                            {asset.qr_code_url ? (
                                                <button className="p-1.5 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                                                    <QrCode className="w-4 h-4 text-gray-600" />
                                                </button>
                                            ) : (
                                                <button className="text-[10px] font-bold text-[#0047AB] hover:underline">Generate</button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}

function KPICard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
    const colorClasses: Record<string, string> = { blue: 'bg-blue-50 text-blue-600', green: 'bg-green-50 text-green-600', amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600' };
    return (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${colorClasses[color]}`}>{icon}</div>
            <p className="text-2xl font-black text-gray-900">{value}</p>
            <p className="text-xs font-medium text-gray-400 mt-1">{label}</p>
        </div>
    );
}
