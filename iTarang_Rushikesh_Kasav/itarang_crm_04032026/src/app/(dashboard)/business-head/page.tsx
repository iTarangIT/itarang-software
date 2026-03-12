'use client';

import { KPICard } from '@/components/shared/kpi-card';
import { MetricsChart } from '@/components/shared/charts';
import { DataTable } from '@/components/shared/data-table';
import {
    Users,
    TrendingUp,
    Clock,
    UserCheck,
    Battery,
    Briefcase
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/dashboard/ErrorBoundary';

export default function BusinessHeadDashboard() {
    const { data: metricsResponse, isLoading } = useQuery({
        queryKey: ['dashboard', 'business_head'],
        queryFn: async () => {
            const res = await fetch('/api/dashboard/business_head');
            if (!res.ok) throw new Error('Failed to fetch metrics');
            return res.json();
        }
    });

    const metrics = metricsResponse?.data;

    if (isLoading) return <div className="p-8 text-center text-slate-500">Loading Dashboard...</div>;

    const kpis = [
        {
            title: 'Lead Conversion (MTD)',
            value: metrics?.conversionRate ? `${metrics.conversionRate}%` : '0%',
            trend: 2.1,
            icon: TrendingUp,
            suffix: 'vs last month'
        },
        {
            title: 'Active Leads',
            value: metrics?.activeLeads?.toString() || '0',
            trend: 5.4,
            icon: Users,
            suffix: 'total active'
        },
        {
            title: 'Avg. Qualification Time',
            value: metrics?.avgQualificationTime || '1.8 Days',
            trend: -12,
            icon: Clock,
            trendPositive: true,
            suffix: 'faster than avg'
        },
        {
            title: 'Pending Approvals (L2)',
            value: metrics?.pendingApprovals?.toString() || '0',
            icon: UserCheck,
            trend: 0,
            suffix: 'Requires Action'
        }
    ];

    const approvalColumns = [
        { header: 'Deal ID', accessor: 'id' },
        { header: 'OEM', accessor: 'oem' },
        {
            header: 'Value',
            accessor: 'value',
            render: (val: any) => <span className="font-bold text-emerald-600">₹{parseFloat(val).toLocaleString()}</span>
        },
        { header: 'Item', accessor: 'item' },
        {
            header: 'Status',
            accessor: 'status',
            render: (val: string) => (
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-medium">
                    {val.replace(/_/g, ' ')}
                </span>
            )
        },
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
            <header>
                <h1 className="text-2xl font-bold text-slate-900">Business Head Dashboard</h1>
                <p className="text-slate-500">Sales performance and operational oversight</p>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {kpis.map((kpi, i) => (
                    <KPICard key={i} {...kpi} />
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Lead Performance Chart */}
                <ErrorBoundary title="Lead Performance Chart Failed">
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                        <h3 className="text-lg font-semibold mb-6 flex items-center gap-2">
                            <TrendingUp className="w-5 h-5 text-emerald-600" />
                            Lead Progress (Weekly)
                        </h3>
                        <div className="h-[300px]">
                            <MetricsChart
                                type="area"
                                data={metrics?.leadTrend || []}
                                dataKeys={['total', 'qualified']}
                                categoryKey="name"
                                colors={['#10b981', '#3b82f6']}
                                title="Lead Progress (Weekly)"
                            />
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Battery Category Performance */}
                <ErrorBoundary title="Category Distribution Chart Failed">
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                        <h3 className="text-lg font-semibold mb-6 flex items-center gap-2">
                            <Battery className="w-5 h-5 text-emerald-600" />
                            Category Distribution
                        </h3>
                        <div className="h-[300px]">
                            <MetricsChart
                                type="bar"
                                data={metrics?.categoryStats || []}
                                dataKeys={['count']}
                                categoryKey="name"
                                colors={['#10b981']}
                                title="Category Distribution"
                            />
                        </div>
                    </div>
                </ErrorBoundary>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Approval Queue */}
                <div className="lg:col-span-2">
                    <ErrorBoundary title="Approval Queue Failed">
                        <DataTable
                            title="Level 2 Approval Queue"
                            columns={approvalColumns}
                            data={metrics?.approvalQueue || []}
                            searchPlaceholder="Search deals..."
                            icon={<Briefcase className="w-5 h-5 text-emerald-600" />}
                        />
                    </ErrorBoundary>
                </div>

                {/* Team Performance */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-semibold mb-4">Top Lead Actors</h3>
                    <div className="space-y-4">
                        {[
                            { name: 'Rahul Sharma', conversions: 42, score: 94 },
                            { name: 'Priya Verma', conversions: 38, score: 88 },
                            { name: 'Amit Singh', conversions: 35, score: 85 },
                            { name: 'Neha Gupta', conversions: 31, score: 82 },
                        ].map((actor) => (
                            <div key={actor.name} className="space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span className="font-medium text-slate-700">{actor.name}</span>
                                    <span className="text-slate-500">{actor.conversions} leads</span>
                                </div>
                                <div className="w-full bg-slate-100 rounded-full h-1.5">
                                    <div
                                        className="bg-emerald-500 h-1.5 rounded-full"
                                        style={{ width: `${actor.score}%` }}
                                    ></div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
