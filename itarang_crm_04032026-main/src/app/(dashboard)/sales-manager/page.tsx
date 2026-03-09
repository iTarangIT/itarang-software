"use client";

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { KPICard } from '@/components/shared/kpi-card';
import { MetricsChart } from '@/components/shared/charts';
import {
    Users,
    TrendingUp,
    FileCheck,
    PhoneCall,
    Clock,
    CheckCircle2,
    Target,
    ArrowRight,
    Loader2,
    AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';

import { DataTable } from '@/components/shared/data-table';

const leadsData = [
    { id: 1, name: 'Kishan G Auto', state: 'Delhi', source: 'Ground Sales', level: 'Hot' },
    { id: 2, name: 'SR Enterprises', state: 'UP', source: 'Dealer Ref', level: 'Warm' },
    { id: 3, name: 'Modern Motors', state: 'Haryana', source: 'Digital', level: 'Hot' },
    { id: 4, name: 'Patil Agencies', state: 'Maharasthra', source: 'Ground Sales', level: 'Cold' },
    { id: 5, name: 'Delhi Fleet Services', state: 'Delhi', source: 'Inbound', level: 'Hot' },
];

const leadColumns: any[] = [
    { header: 'Customer', accessorKey: 'name', cell: (item: any) => <p className="font-bold text-gray-900">{item.name}</p> },
    { header: 'State', accessorKey: 'state' },
    { header: 'Source', accessorKey: 'source' },
    {
        header: 'Interest Level',
        accessorKey: 'level',
        cell: (item: any) => (
            <span className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-bold",
                item.level === 'Hot' ? "bg-rose-50 text-rose-600" :
                    item.level === 'Warm' ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-600"
            )}>
                {item.level}
            </span>
        )
    },
];

const dealData = [
    { status: 'Qualified', count: 12 },
    { status: 'Negotiation', count: 8 },
    { status: 'Closing', count: 5 },
    { status: 'On Hold', count: 3 },
];

export default function SalesManagerDashboard() {
    const { data: metrics, isLoading, error } = useQuery({
        queryKey: ['dashboard-metrics', 'sales_manager'],
        queryFn: async () => {
            const response = await fetch('/api/dashboard/sales_manager');
            if (!response.ok) throw new Error('Failed to fetch dashboard metrics');
            return response.json();
        },
        refetchInterval: 60000,
    });

    if (isLoading) {
        return (
            <div className="h-[60vh] flex flex-col items-center justify-center gap-4">
                <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
                <p className="text-sm text-gray-500 font-medium">Loading sales performance data...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-8 rounded-2xl bg-red-50 border border-red-100 text-center">
                <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-red-900">Dashboard Unreachable</h3>
                <p className="text-sm text-red-600 mt-2">There was an error loading the metrics.</p>
            </div>
        );
    }

    const m = metrics || {};

    return (
        <div className="space-y-8 pb-12">
            <div>
                <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Sales Performance Dashboard</h1>
                <p className="text-sm text-gray-500 mt-1">Track your leads, active deals, and conversion targets.</p>
            </div>

            {/* KPI Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <KPICard
                    title="Active Leads"
                    value={Number(m.activeLeads ?? 0).toString()}
                    change={{ value: 5.4, period: 'vs last week', isPositive: true }}
                    icon={Users}
                />
                <KPICard
                    title="Pipeline Value"
                    value={`₹${(Number(m.pipelineValue ?? 0) / 100000).toFixed(1)}L`}
                    change={{ value: 12.8, period: 'vs last week', isPositive: true }}
                    icon={Target}
                />
                <KPICard
                    title="Hot Leads"
                    value={Number(m.hotLeads ?? 0).toString()}
                    change={{ value: 8.2, period: 'vs last week', isPositive: true }}
                    icon={TrendingUp}
                />
                <KPICard
                    title="Conversion Rate"
                    value="14.2%"
                    change={{ value: 0.5, period: 'vs last week', isPositive: false }}
                    icon={Target}
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2">
                    <MetricsChart
                        title="Deal Status Distribution"
                        data={dealData}
                        dataKeys={['count']}
                        categoryKey="status"
                        type="bar"
                    />
                </div>

                <div className="space-y-6">
                    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm relative overflow-hidden">
                        <div className="absolute top-0 right-0 p-4">
                            <Clock className="w-12 h-12 text-blue-50 opacity-10" />
                        </div>
                        <h3 className="text-sm font-semibold text-gray-900 mb-6 flex items-center gap-2">
                            Follow-up Alerts
                        </h3>
                        <div className="space-y-4">
                            {[
                                { name: 'Vinay Motors', time: '10:30 AM', priority: 'High' },
                                { name: 'E-Way Fleets', time: '02:00 PM', priority: 'Medium' },
                                { name: 'Green Auto', time: '04:30 PM', priority: 'High' },
                            ].map((alert) => (
                                <div key={alert.name} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 bg-gray-50/50">
                                    <div className={cn(
                                        "w-2 h-2 rounded-full",
                                        alert.priority === 'High' ? "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.4)]" : "bg-brand-500"
                                    )}></div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold text-gray-900 truncate">{alert.name}</p>
                                        <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">{alert.time}</p>
                                    </div>
                                    <button className="p-1.5 hover:bg-white rounded-lg transition-colors">
                                        <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="p-6 rounded-2xl bg-slate-900 text-white shadow-xl shadow-slate-200">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center">
                                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold">Target Status</h3>
                                <p className="text-[10px] text-slate-400 font-medium">MTD Progress</p>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <div className="space-y-1.5">
                                <div className="flex justify-between text-[11px] font-bold">
                                    <span className="text-slate-400">Monthly Target</span>
                                    <span>72%</span>
                                </div>
                                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                                    <div className="h-full bg-brand-500 w-[72%] rounded-full shadow-[0_0_12px_rgba(5,150,105,0.4)]"></div>
                                </div>
                            </div>
                            <p className="text-[11px] text-slate-400 italic leading-relaxed">
                                You need to close ₹4.2L more to reach your platinum tier goal.
                            </p>
                            <button className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-white text-[11px] font-bold rounded-xl transition-all border border-slate-700">
                                View Full Report
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Recent Leads Table */}
            <DataTable
                title="Recently Assigned Leads"
                data={leadsData}
                columns={leadColumns}
                searchPlaceholder="Search leads by name, state or source..."
                pageSize={5}
            />
        </div>
    );
}
