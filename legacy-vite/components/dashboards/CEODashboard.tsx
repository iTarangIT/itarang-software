import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { TrendingUp, DollarSign, Users, Package, Phone, Target, Loader2 } from 'lucide-react';

interface KPI {
    label: string;
    value: string;
    change: string;
    trend: 'up' | 'down';
    icon: React.ReactNode;
    color: string;
}

export const CEODashboard: React.FC = () => {
    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<KPI[]>([]);
    const [revenueData, setRevenueData] = useState<any[]>([]);
    const [teamPerformance, setTeamPerformance] = useState<any[]>([]);

    useEffect(() => {
        fetchDashboardData();
    }, []);

    async function fetchDashboardData() {
        try {
            setLoading(true);

            // Fetch KPIs
            const [
                { count: leadsCount },
                { count: ordersCount },
                { count: provisionsCount },
                { count: callsCount },
            ] = await Promise.all([
                supabase.from('leads').select('*', { count: 'exact', head: true }),
                supabase.from('orders').select('*', { count: 'exact', head: true }),
                supabase.from('provisions').select('*', { count: 'exact', head: true }),
                supabase.from('bolna_calls').select('*', { count: 'exact', head: true }),
            ]);

            // Fetch conversions for revenue calculation
            const { data: conversions } = await supabase
                .from('conversions')
                .select('value');

            const totalRevenue = conversions?.reduce((sum, c) => sum + Number(c.value), 0) || 0;

            // Fetch revenue trend data
            const { data: revenueDataFromDB } = await supabase
                .from('revenue_data')
                .select('*')
                .order('order_index', { ascending: true });

            setRevenueData(revenueDataFromDB || []);

            // Mock team performance data (in production, calculate from actual data)
            const mockTeamPerformance = [
                { name: 'Manager A', conversions: 12, calls: 45, qualified: 28 },
                { name: 'Manager B', conversions: 9, calls: 38, qualified: 22 },
                { name: 'Manager C', conversions: 15, calls: 52, qualified: 35 },
                { name: 'Manager D', conversions: 7, calls: 30, qualified: 18 },
            ];
            setTeamPerformance(mockTeamPerformance);

            setKpis([
                {
                    label: 'Total Revenue',
                    value: `₹${(totalRevenue / 100000).toFixed(1)}L`,
                    change: '+12.5%',
                    trend: 'up',
                    icon: <DollarSign className="w-5 h-5" />,
                    color: 'from-green-50 to-green-100',
                },
                {
                    label: 'Active Leads',
                    value: String(leadsCount || 0),
                    change: '+8.2%',
                    trend: 'up',
                    icon: <Users className="w-5 h-5" />,
                    color: 'from-blue-50 to-blue-100',
                },
                {
                    label: 'Total Orders',
                    value: String(ordersCount || 0),
                    change: '+15.3%',
                    trend: 'up',
                    icon: <Package className="w-5 h-5" />,
                    color: 'from-purple-50 to-purple-100',
                },
                {
                    label: 'AI Calls',
                    value: String(callsCount || 0),
                    change: '+22.1%',
                    trend: 'up',
                    icon: <Phone className="w-5 h-5" />,
                    color: 'from-pink-50 to-pink-100',
                },
                {
                    label: 'Provisions',
                    value: String(provisionsCount || 0),
                    change: '+5.7%',
                    trend: 'up',
                    icon: <Target className="w-5 h-5" />,
                    color: 'from-amber-50 to-amber-100',
                },
                {
                    label: 'Conversion Rate',
                    value: '24.5%',
                    change: '+3.2%',
                    trend: 'up',
                    icon: <TrendingUp className="w-5 h-5" />,
                    color: 'from-teal-50 to-teal-100',
                },
            ]);
        } catch (error) {
            console.error('Error fetching dashboard data:', error);
        } finally {
            setLoading(false);
        }
    }

    if (loading) {
        return (
            <div className="space-y-8 animate-fade-in pb-12">
                <div className="flex justify-between items-end">
                    <div className="space-y-2">
                        <div className="h-8 w-64 bg-slate-200 rounded-lg animate-pulse" />
                        <div className="h-4 w-48 bg-slate-100 rounded animate-pulse" />
                    </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="h-48 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
                    <div className="h-48 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
                    <div className="h-48 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="h-24 bg-slate-50 rounded-xl border border-slate-100 animate-pulse" />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-fade-in pb-12">
            <div className="flex justify-between items-end">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Executive Dashboard</h1>
                    <p className="text-gray-500 text-sm mt-1">Strategic oversight and cross-functional performance</p>
                </div>
                <div className="text-sm text-gray-400 bg-white px-4 py-2 rounded-xl border border-gray-100 shadow-sm">
                    Updated: {new Date().toLocaleTimeString()}
                </div>
            </div>

            {/* Dominant KPI Grid - Focal Points (v2.1) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Revenue Card - Primary Focal Point */}
                <div className="bg-white p-6 rounded-2xl border-2 border-primary-100 shadow-lg shadow-primary-900/5 relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                        <DollarSign className="w-24 h-24 text-primary-600" />
                    </div>
                    <div className="flex items-center gap-3 mb-6">
                        <div className="p-3 bg-primary-100 text-primary-700 rounded-xl">
                            <DollarSign className="w-6 h-6" />
                        </div>
                        <span className="font-semibold text-gray-600">Total Revenue (MTD)</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                        <h2 className="text-4xl font-black text-gray-900 tracking-tight">₹12.4L</h2>
                        <span className="text-green-600 text-sm font-bold flex items-center">
                            <TrendingUp className="w-4 h-4 mr-0.5" />
                            18.5%
                        </span>
                    </div>
                    <div className="mt-6">
                        <div className="flex justify-between text-xs text-gray-500 mb-2">
                            <span>Progress to target</span>
                            <span>82.7%</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-2">
                            <div className="bg-primary-600 h-2 rounded-full shadow-sm" style={{ width: '82.7%' }}></div>
                        </div>
                    </div>
                </div>

                {/* Conversion Card */}
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm relative overflow-hidden">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="p-3 bg-purple-100 text-purple-700 rounded-xl">
                            <TrendingUp className="w-6 h-6" />
                        </div>
                        <span className="font-semibold text-gray-600">Conversion Rate</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                        <h2 className="text-4xl font-black text-gray-900 tracking-tight">24.5%</h2>
                        <span className="text-green-600 text-sm font-bold flex items-center">
                            +2.1%
                        </span>
                    </div>
                    <div className="mt-6 grid grid-cols-2 gap-4">
                        <div className="bg-slate-50 p-2 rounded-lg border border-slate-100">
                            <p className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">AI Qualified</p>
                            <p className="text-lg font-bold text-gray-800">26.3%</p>
                        </div>
                        <div className="bg-slate-50 p-2 rounded-lg border border-slate-100">
                            <p className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">Manual</p>
                            <p className="text-lg font-bold text-gray-800">22.1%</p>
                        </div>
                    </div>
                </div>

                {/* Inventory Card */}
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm relative overflow-hidden">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="p-3 bg-amber-100 text-amber-700 rounded-xl">
                            <Package className="w-6 h-6" />
                        </div>
                        <span className="font-semibold text-gray-600">Inventory Value</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                        <h2 className="text-4xl font-black text-gray-900 tracking-tight">₹45.2L</h2>
                    </div>
                    <div className="mt-6 flex items-center justify-between p-3 bg-amber-50 rounded-xl border border-amber-100">
                        <div>
                            <p className="text-xs text-amber-900 font-medium">1,245 units in stock</p>
                            <p className="text-[10px] text-amber-700">12 Pending GRNs</p>
                        </div>
                        <div className="text-right">
                            <p className="text-[10px] text-amber-700 uppercase font-bold">Accuracy</p>
                            <p className="text-sm font-bold text-amber-900">98.7%</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Sub-KPI Row - Neutral Palette (SOP Principle #2.2) */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                    { label: 'Active Leads', value: kpis.find(k => k.label === 'Active Leads')?.value || '0', icon: Users, color: 'text-slate-500', bg: 'bg-slate-50' },
                    { label: 'Total Orders', value: kpis.find(k => k.label === 'Total Orders')?.value || '0', icon: Package, color: 'text-slate-500', bg: 'bg-slate-50' },
                    { label: 'AI Calls', value: kpis.find(k => k.label === 'AI Calls')?.value || '0', icon: Phone, color: 'text-slate-500', bg: 'bg-slate-50' },
                    { label: 'Outstanding', value: '₹8.9L', icon: Target, color: 'text-red-500', bg: 'bg-red-50/50' },
                ].map((stat, i) => (
                    <div key={i} className={`p-4 rounded-xl border border-slate-100 shadow-sm flex items-center justify-between transition-all hover:shadow-md hover:border-slate-200 ${stat.bg}`}>
                        <div>
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{stat.label}</p>
                            <p className="text-xl font-bold text-slate-900">{stat.value}</p>
                        </div>
                        <div className={`p-2 rounded-lg bg-white shadow-sm`}>
                            <stat.icon className={`w-4 h-4 ${stat.color}`} />
                        </div>
                    </div>
                ))}
            </div>

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Revenue Trend */}
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <h3 className="text-lg font-bold text-gray-900 mb-4">Revenue Trend</h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={revenueData}>
                                <defs>
                                    <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                <XAxis dataKey="month" tick={{ fill: '#9CA3AF', fontSize: 12 }} />
                                <YAxis tick={{ fill: '#9CA3AF', fontSize: 12 }} />
                                <Tooltip />
                                <Area type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* Team Performance */}
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <h3 className="text-lg font-bold text-gray-900 mb-4">Team Performance</h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={teamPerformance}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                <XAxis dataKey="name" tick={{ fill: '#9CA3AF', fontSize: 12 }} />
                                <YAxis tick={{ fill: '#9CA3AF', fontSize: 12 }} />
                                <Tooltip />
                                <Bar dataKey="conversions" fill="#3b82f6" radius={[8, 8, 0, 0]} />
                                <Bar dataKey="qualified" fill="#8b5cf6" radius={[8, 8, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>

            {/* Individual Performance Table */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                    <h2 className="text-lg font-bold text-gray-900">Individual Performance Metrics</h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-gray-50 border-b border-gray-100">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Manager</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Conversions</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">AI Calls</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Qualified</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Conversion Rate</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {teamPerformance.map((member, idx) => (
                                <tr key={idx} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-6 py-4 font-medium text-gray-900">{member.name}</td>
                                    <td className="px-6 py-4 text-gray-600">{member.conversions}</td>
                                    <td className="px-6 py-4 text-gray-600">{member.calls}</td>
                                    <td className="px-6 py-4 text-gray-600">{member.qualified}</td>
                                    <td className="px-6 py-4">
                                        <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
                                            {((member.conversions / member.calls) * 100).toFixed(1)}%
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};
