"use client";

import React from 'react';
import { KPICard } from '@/components/shared/kpi-card';
import { MetricsChart } from '@/components/shared/charts';
import {
    Package,
    AlertTriangle,
    UploadCloud,
    Database,
    PlusCircle,
    ArrowRight,
    Search,
    History
} from 'lucide-react';

const inventoryTrend = [
    { date: '01 Jan', level: 120 },
    { date: '05 Jan', level: 145 },
    { date: '10 Jan', level: 138 },
    { date: '15 Jan', level: 162 },
    { date: '20 Jan', level: 155 },
];

export default function InventoryManagerDashboard() {
    return (
        <div className="space-y-8 pb-12">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Inventory Control Console</h1>
                    <p className="text-sm text-gray-500 mt-1">Manage product catalog, stock levels, and bulk data operations.</p>
                </div>
                <div className="flex gap-3">
                    <button className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-xs font-bold rounded-xl shadow-sm hover:bg-gray-50 transition-all flex items-center gap-2">
                        <History className="w-3.5 h-3.5" /> View Activity
                    </button>
                    <button className="px-4 py-2 bg-brand-600 text-white text-xs font-bold rounded-xl shadow-lg shadow-brand-500/20 hover:bg-brand-700 transition-all flex items-center gap-2">
                        <PlusCircle className="w-3.5 h-3.5" /> Add Product
                    </button>
                </div>
            </div>

            {/* KPI Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <KPICard
                    title="Total Catalog Items"
                    value="124"
                    icon={Database}
                />
                <KPICard
                    title="Total Active Stock"
                    value="1,842"
                    change={{ value: 1.2, period: 'vs last week', isPositive: true }}
                    icon={Package}
                />
                <KPICard
                    title="Low Stock Alerts"
                    value="14"
                    change={{ value: 3, period: 'new this week', isPositive: false }}
                    icon={AlertTriangle}
                />
                <KPICard
                    title="Pending Bulk Uploads"
                    value="2"
                    icon={UploadCloud}
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2">
                    <MetricsChart
                        title="Stock Usage Trend"
                        data={inventoryTrend}
                        dataKeys={['level']}
                        categoryKey="date"
                        type="area"
                    />
                </div>

                <div className="space-y-6">
                    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm relative overflow-hidden">
                        <h3 className="text-sm font-semibold text-gray-900 mb-6 flex items-center gap-2">
                            Quick Operations
                        </h3>
                        <div className="space-y-3">
                            <button className="w-full flex items-center justify-between p-4 rounded-xl border border-gray-100 bg-gray-50/50 hover:bg-brand-50 hover:border-brand-100 group transition-all">
                                <div className="flex items-center gap-3 text-left">
                                    <div className="p-2 bg-white rounded-lg shadow-sm">
                                        <UploadCloud className="w-4 h-4 text-brand-600" />
                                    </div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-900">Bulk Upload</p>
                                        <p className="text-[10px] text-gray-500">CSV, Excel support</p>
                                    </div>
                                </div>
                                <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-brand-600" />
                            </button>

                            <button className="w-full flex items-center justify-between p-4 rounded-xl border border-gray-100 bg-gray-50/50 hover:bg-brand-50 hover:border-brand-100 group transition-all">
                                <div className="flex items-center gap-3 text-left">
                                    <div className="p-2 bg-white rounded-lg shadow-sm">
                                        <Search className="w-4 h-4 text-brand-600" />
                                    </div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-900">Serial Search</p>
                                        <p className="text-[10px] text-gray-500">Track individual asset</p>
                                    </div>
                                </div>
                                <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-brand-600" />
                            </button>
                        </div>
                    </div>

                    <div className="p-6 rounded-2xl bg-gradient-to-br from-gray-900 to-slate-800 text-white shadow-xl">
                        <h3 className="text-sm font-bold mb-4">Storage Capacity</h3>
                        <div className="space-y-4">
                            {[
                                { name: 'Main Warehouse', usage: '84%' },
                                { name: 'Transit Hub', usage: '32%' },
                                { name: 'Regional Office', usage: '15%' },
                            ].map((hub) => (
                                <div key={hub.name} className="space-y-1.5">
                                    <div className="flex justify-between text-[11px] font-bold">
                                        <span className="text-gray-400">{hub.name}</span>
                                        <span>{hub.usage}</span>
                                    </div>
                                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                                        <div
                                            className={cn(
                                                "h-full rounded-full transition-all duration-500",
                                                parseInt(hub.usage) > 80 ? "bg-rose-500" : "bg-emerald-500"
                                            )}
                                            style={{ width: hub.usage }}
                                        ></div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Low Stock Watchlist */}
            <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm overflow-x-auto">
                <div className="flex items-center justify-between mb-6">
                    <h3 className="text-sm font-semibold text-gray-900">Low Stock Watchlist</h3>
                    <button className="text-xs font-semibold text-brand-700 hover:underline">Reorder All</button>
                </div>
                <table className="w-full text-left">
                    <thead>
                        <tr className="border-b border-gray-50">
                            <th className="pb-3 text-[10px] font-bold text-gray-400 uppercase tracking-wider">Product Model</th>
                            <th className="pb-3 text-[10px] font-bold text-gray-400 uppercase tracking-wider">Category</th>
                            <th className="pb-3 text-[10px] font-bold text-gray-400 uppercase tracking-wider text-center">Available</th>
                            <th className="pb-3 text-[10px] font-bold text-gray-400 uppercase tracking-wider text-center">Threshold</th>
                            <th className="pb-3 text-[10px] font-bold text-gray-400 uppercase tracking-wider text-right">Status</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                        {[
                            { model: 'ITAR-EV-24-60', cat: 'Battery', stock: 8, min: 20 },
                            { model: 'CHARG-MAX-30', cat: 'Charger', stock: 12, min: 25 },
                            { model: 'SOC-DIS-V2', cat: 'SOC', stock: 4, min: 15 },
                            { model: 'ITAR-EV-36-80', cat: 'Battery', stock: 2, min: 15 },
                        ].map((item) => (
                            <tr key={item.model} className="group">
                                <td className="py-4">
                                    <p className="text-sm font-bold text-gray-900">{item.model}</p>
                                </td>
                                <td className="py-4 text-xs font-medium text-gray-500">{item.cat}</td>
                                <td className="py-4 text-xs font-bold text-gray-900 text-center">{item.stock}</td>
                                <td className="py-4 text-xs font-medium text-gray-400 text-center">{item.min}</td>
                                <td className="py-4 text-right">
                                    <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-600 text-[10px] font-bold">
                                        CRITICAL
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

const cn = (...inputs: any[]) => inputs.filter(Boolean).join(' ');
