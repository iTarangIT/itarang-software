'use client';

import { useAuth } from '@/components/auth/AuthProvider';
import { KPICard } from '@/components/shared/kpi-card';
import { MetricsChart } from '@/components/shared/charts';
import {
    Target,
    TrendingUp,
    BarChart3,
    Users,
    MapPin,
    PieChart,
    ArrowUpRight,
    Search
} from 'lucide-react';
import { useEffect, useState } from 'react';

export default function SalesHeadDashboard() {
    const { user } = useAuth();
    const [metrics, setMetrics] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchMetrics() {
            try {
                const res = await fetch('/api/dashboard/sales_head');
                const result = await res.json();
                if (result.success) {
                    setMetrics(result.data);
                }
            } catch (err) {
                console.error('Failed to fetch sales head metrics:', err);
            } finally {
                setLoading(false);
            }
        }
        fetchMetrics();
    }, []);

    if (loading) return <div className="p-8">Loading Sales Overview...</div>;

    const kpis = [
        {
            title: 'Monthly Sales Target',
            value: '₹4.5 Cr',
            trend: 72, // Progress percentage
            icon: Target,
            suffix: '72% Achieved'
        },
        {
            title: 'Pipeline Revenue',
            value: '₹12.8 Cr',
            trend: 12.5,
            icon: TrendingUp,
            suffix: 'vs last week'
        },
        {
            title: 'Overall Team LVR',
            value: '3.2x',
            trend: 0.4,
            icon: BarChart3,
            suffix: 'Lead Value Ratio'
        },
        {
            title: 'Expansion (Regions)',
            value: '6',
            icon: MapPin,
            trend: 2,
            suffix: '+2 New Regions'
        }
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
            <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900">Sales Head Dashboard</h1>
                    <p className="text-slate-500">Overall sales strategy and regional performance</p>
                </div>
                <div className="flex gap-2">
                    <button className="px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
                        Download Report
                    </button>
                    <button className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors">
                        View Team Performance
                    </button>
                </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {kpis.map((kpi, i) => (
                    <KPICard key={i} {...kpi} />
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Revenue Breakdown by Region */}
                <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-semibold mb-6 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <MapPin className="w-5 h-5 text-emerald-600" />
                            Regional Performance
                        </div>
                        <div className="text-xs text-slate-400 font-normal">Revenue Distribution (In Lakhs)</div>
                    </h3>
                    <div className="h-[350px]">
                        <MetricsChart
                            type="bar"
                            data={metrics?.regionalPerformance || [
                                { name: 'North West', Revenue: 185, Target: 150 },
                                { name: 'NCR', Revenue: 120, Target: 140 },
                                { name: 'Central India', Revenue: 95, Target: 80 },
                                { name: 'East', Revenue: 45, Target: 60 },
                                { name: 'SouthWest', Revenue: 110, Target: 100 },
                            ]}
                            dataKeys={['Revenue', 'Target']}
                            categoryKey="name"
                            colors={['#10b981', '#cbd5e1']}
                            title="Regional Performance"
                        />
                    </div>
                </div>

                {/* Lead Sourcing Efficiency */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-semibold mb-6 flex items-center gap-2">
                        <PieChart className="w-5 h-5 text-emerald-600" />
                        Lead Sources
                    </h3>
                    <div className="space-y-6">
                        {[
                            { name: 'Ground Sales', value: '45%', count: 185, color: '#10b981' },
                            { name: 'OEM Referral', value: '30%', count: 124, color: '#3b82f6' },
                            { name: 'Social Media', value: '15%', count: 62, color: '#f59e0b' },
                            { name: 'Organic Web', value: '10%', count: 41, color: '#6366f1' },
                        ].map((source) => (
                            <div key={source.name} className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: source.color }}></div>
                                    <span className="text-sm font-medium text-slate-700">{source.name}</span>
                                </div>
                                <div className="text-right">
                                    <div className="text-sm font-bold text-slate-900">{source.value}</div>
                                    <div className="text-xs text-slate-500">{source.count} Leads</div>
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="mt-8 pt-6 border-t border-slate-100 italic text-xs text-slate-500 text-center">
                        "OEM Referrals showing 20% week-over-week growth"
                    </div>
                </div>
            </div>

            {/* Strategic Overview Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
                    <div>
                        <h3 className="text-lg font-semibold mb-4">Pipeline Velocity</h3>
                        <div className="flex items-center gap-4 mb-6">
                            <div className="p-4 bg-blue-50 rounded-xl">
                                <TrendingUp className="w-8 h-8 text-blue-600" />
                            </div>
                            <div>
                                <div className="text-3xl font-bold">14.2 Days</div>
                                <p className="text-sm text-slate-500">Average time from Lead to Deal Conclusion</p>
                            </div>
                        </div>
                    </div>
                    <div className="bg-blue-50 p-4 rounded-xl flex items-center justify-between">
                        <span className="text-sm font-medium text-blue-800">Target Velocity: 12 Days</span>
                        <ArrowUpRight className="w-4 h-4 text-blue-800" />
                    </div>
                </div>

                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-semibold mb-4">Top Performing Managers</h3>
                    <div className="space-y-4">
                        {[
                            { name: 'Vikram Seth', region: 'North West', achievement: 105 },
                            { name: 'Anjali Menon', region: 'SouthWest', achievement: 102 },
                            { name: 'Karan Mehra', region: 'Central India', achievement: 98 },
                        ].map((mgr) => (
                            <div key={mgr.name} className="flex items-center justify-between p-3 rounded-xl border border-slate-100 hover:border-emerald-200 transition-all cursor-pointer group">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-bold">
                                        {mgr.name[0]}
                                    </div>
                                    <div>
                                        <div className="font-medium text-slate-900 group-hover:text-emerald-700 translate-all">{mgr.name}</div>
                                        <div className="text-xs text-slate-500">{mgr.region}</div>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-sm font-bold text-slate-900">{mgr.achievement}%</div>
                                    <div className="text-[10px] uppercase font-bold text-emerald-600">Reached Target</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
