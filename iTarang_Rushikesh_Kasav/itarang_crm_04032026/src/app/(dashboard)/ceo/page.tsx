"use client";

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { KPICard } from '@/components/shared/kpi-card';
import { MetricsChart } from '@/components/shared/charts';
import {
    TrendingUp,
    DollarSign,
    Package,
    AlertCircle,
    ArrowRight,
    UserCheck,
    Briefcase,
    Loader2,
    Users
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';


export default function CEODashboard() {
    const { data: metrics, isLoading, error } = useQuery({
        queryKey: ['dashboard-metrics', 'ceo'],
        queryFn: async () => {
            const response = await fetch('/api/dashboard/ceo');
            if (!response.ok) throw new Error('Failed to fetch dashboard metrics');
            const result = await response.json();
            return result.data; // API returns { data: ... }
        },
        refetchInterval: 60000,
    });

    if (isLoading) {
        return (
            <div className="h-[60vh] flex flex-col items-center justify-center gap-4">
                <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
                <p className="text-sm text-gray-500 font-medium">Loading executive analytics...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-8 rounded-2xl bg-red-50 border border-red-100 text-center">
                <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-red-900">Dashboard Unreachable</h3>
                <p className="text-sm text-red-600 mt-2">There was an error loading the metrics. Please try again later.</p>
            </div>
        );
    }

    const m = metrics || {};

    return (
        <div className="space-y-8 pb-12">
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">CEO Executive Overview</h1>
                    <p className="text-sm text-gray-500 mt-1">Real-time business performance and strategic metrics.</p>
                </div>
                <Link href="/leads">
                    <Button className="bg-brand-600 hover:bg-brand-700 text-white flex items-center gap-2">
                        <Users className="w-4 h-4" />
                        Go to Leads
                    </Button>
                </Link>
            </div>

            {/* KPI Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <KPICard
                    title="Revenue (MTD)"
                    value={`₹${(Number(m.revenue ?? 0) / 100000).toFixed(1)}L`}
                    change={{ value: 12.5, period: 'vs last month', isPositive: true }}
                    icon={DollarSign}
                />
                <KPICard
                    title="Conversion Rate"
                    value={`${Number(m.conversionRate ?? 0).toFixed(1)}%`}
                    change={{ value: 2.1, period: 'vs last month', isPositive: true }}
                    icon={TrendingUp}
                />
                <KPICard
                    title="Inventory Value"
                    value={`₹${(Number(m.inventoryValue ?? 0) / 100000).toFixed(1)}L`}
                    change={{ value: 4.2, period: 'vs last month', isPositive: false }}
                    icon={Package}
                />
                <KPICard
                    title="Outstanding Credits"
                    value={`₹${(Number(m.outstandingCredits ?? 0) / 100000).toFixed(1)}L`}
                    change={{ value: 8.4, period: 'vs last month', isPositive: true }}
                    icon={AlertCircle}
                />
            </div>

            {/* Charts and Details Section */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2">
                    <MetricsChart
                        title="Revenue Performance Trend"
                        data={m.revenueTrend || []}
                        dataKeys={['revenue']}
                        categoryKey="name"
                        type="area"
                    />
                </div>

                <div className="space-y-6">
                    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
                        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                            <Briefcase className="w-4 h-4 text-brand-600" />
                            Procurement Overview
                        </h3>
                        <div className="space-y-4">
                            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                                <span className="text-xs font-medium text-gray-600">Pending Approvals</span>
                                <span className="text-xs font-bold text-brand-700">{m.procurementStats?.pendingApprovals || 0} Items</span>
                            </div>
                            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                                <span className="text-xs font-medium text-gray-600">Active Procurement</span>
                                <span className="text-xs font-bold text-blue-700">₹{(Number(m.procurementStats?.activeValue ?? 0) / 100000).toFixed(1)}L</span>
                            </div>
                            <Link href="/procurement">
                                <button className="w-full py-2.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
                                    Review Procurement <ArrowRight className="w-3 h-3" />
                                </button>
                            </Link>
                        </div>
                    </div>

                    <div className="p-6 rounded-2xl bg-brand-600 shadow-lg shadow-brand-500/20 text-white relative overflow-hidden">
                        <div className="relative z-10">
                            <UserCheck className="w-8 h-8 opacity-40 mb-4" />
                            <h3 className="text-lg font-bold">HR Management</h3>
                            <p className="text-xs text-brand-100 mt-1 opacity-80 leading-relaxed">
                                Monitor employee performance and manage sales head allocations directly from the HR console.
                            </p>
                            <Link href="/hr">
                                <button className="mt-4 px-4 py-2 bg-white text-brand-700 text-xs font-bold rounded-lg shadow-sm hover:bg-brand-50 transition-colors">
                                    Open Console
                                </button>
                            </Link>
                        </div>
                        <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16 blur-2xl"></div>
                    </div>
                </div>
            </div>

            {/* Sales Teams Overview */}
            <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
                <div className="flex items-center justify-between mb-6">
                    <h3 className="text-sm font-semibold text-gray-900">Top Performing Sales Managers</h3>
                    <Link href="/sales-head">
                        <button className="text-xs font-semibold text-brand-700 hover:underline">View All Teams</button>
                    </Link>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {(m.topSalesManagers || []).map((manager: any) => (
                        <Link key={manager.id} href={`/sales-head/${manager.id}`}>
                            <div className="flex items-center gap-4 p-4 rounded-xl border border-gray-50 bg-gray-50/50 hover:bg-white hover:border-brand-100 transition-all cursor-pointer group">
                                <div className="w-10 h-10 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-sm">
                                    {manager.name.split(' ').map((n: string) => n[0]).join('')}
                                </div>
                                <div className="flex-1">
                                    <p className="text-sm font-bold text-gray-900">{manager.name}</p>
                                    <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">{manager.region}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs font-bold text-brand-700">{manager.conversion}</p>
                                    <p className="text-[10px] text-gray-400 font-medium">Conv.</p>
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>
            </div>
        </div>
    );
}
