import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { Users, TrendingUp, Phone, Target, Loader2, DollarSign, Package, Activity } from 'lucide-react';

interface LeadAssignment {
    id: string;
    name: string;
    phone: string;
    status: string;
    score: number;
    assigned_to: string | null;
    assigned_manager_name?: string;
}

interface Manager {
    id: string;
    full_name: string;
    assigned_count: number;
    conversions: number;
    qualified: number;
}

interface KPI {
    label: string;
    value: string;
    change: string;
    trend: 'up' | 'down';
    icon: React.ReactNode;
    color: string;
    subtext: string;
}

export const SalesHeadDashboard: React.FC = () => {
    const [leads, setLeads] = useState<LeadAssignment[]>([]);
    const [managers, setManagers] = useState<Manager[]>([]);
    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<KPI[]>([]);
    const [revenueData, setRevenueData] = useState<any[]>([]);
    const [teamPerformance, setTeamPerformance] = useState<any[]>([]);
    const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
    const [assigningTo, setAssigningTo] = useState<string>('');

    useEffect(() => {
        fetchData();
    }, []);

    async function fetchData() {
        try {
            setLoading(true);

            // Fetch leads, managers, and operational data in parallel
            const [
                { data: leadsData, error: leadsError },
                { data: managersRoleData, error: managersError },
                { count: ordersCount },
                { count: provisionsCount },
                { count: callsCount },
                { data: conversions },
                { data: revenueTrend }
            ] = await Promise.all([
                supabase.from('leads').select('*, assigned_user:users!assigned_to(full_name)').order('created_at', { ascending: false }),
                supabase.from('user_roles').select('user_id, users!inner(id, full_name), roles!inner(name)').eq('roles.name', 'sales_manager'),
                supabase.from('orders').select('*', { count: 'exact', head: true }),
                supabase.from('provisions').select('*', { count: 'exact', head: true }),
                supabase.from('bolna_calls').select('*', { count: 'exact', head: true }),
                supabase.from('conversions').select('*'),
                supabase.from('revenue_data').select('*').order('order_index', { ascending: true })
            ]);

            if (leadsError) {
                console.error('Leads fetch error:', leadsError);
            }
            if (managersError) {
                console.error('Managers fetch error:', managersError);
            }

            // Calculate Metrics
            const totalRevenue = conversions?.reduce((sum, c) => sum + Number(c.value), 0) || 0;
            const managerCounts = new Map<string, { assigned: number; conversions: number; qualified: number }>();

            leadsData?.forEach(lead => {
                if (lead.assigned_to) {
                    const current = managerCounts.get(lead.assigned_to) || { assigned: 0, conversions: 0, qualified: 0 };
                    current.assigned++;
                    if (lead.status === 'Converted') current.conversions++;
                    if (lead.status === 'Qualified') current.qualified++;
                    managerCounts.set(lead.assigned_to, current);
                }
            });

            const managersWithCounts = managersRoleData?.map((m: any) => ({
                id: m.users.id,
                full_name: m.users.full_name,
                assigned_count: managerCounts.get(m.users.id)?.assigned || 0,
                conversions: managerCounts.get(m.users.id)?.conversions || 0,
                qualified: managerCounts.get(m.users.id)?.qualified || 0,
            })) || [];

            setLeads(leadsData?.map((l: any) => ({
                ...l,
                assigned_manager_name: l.assigned_user?.full_name,
            })) || []);
            setManagers(managersWithCounts);
            setRevenueData(revenueTrend || []);
            setTeamPerformance(managersWithCounts.map(m => ({
                name: m.full_name,
                conversions: m.conversions,
                qualified: m.qualified
            })));

            const unassignedCount = leadsData?.filter(l => !l.assigned_to).length || 0;
            const qualifiedCount = leadsData?.filter(l => l.status === 'Qualified').length || 0;

            setKpis([
                {
                    label: 'Total Revenue',
                    value: `₹${(totalRevenue / 100000).toFixed(1)}L`,
                    change: '+14.2%',
                    trend: 'up',
                    icon: <DollarSign className="w-5 h-5" />,
                    color: 'text-green-600',
                    subtext: 'Monthly sales value'
                },
                {
                    label: 'Pending Assignment',
                    value: String(unassignedCount),
                    change: '-5',
                    trend: 'up',
                    icon: <Activity className="w-5 h-5" />,
                    color: 'text-amber-600',
                    subtext: 'Leads needing attention'
                },
                {
                    label: 'Qualified Ratio',
                    value: `${((qualifiedCount / (leadsData?.length || 1)) * 100).toFixed(1)}%`,
                    change: '+2.4%',
                    trend: 'up',
                    icon: <Target className="w-5 h-5" />,
                    color: 'text-blue-600',
                    subtext: 'Lead quality score'
                },
                {
                    label: 'AI Call Volume',
                    value: String(callsCount || 0),
                    change: '+18.1%',
                    trend: 'up',
                    icon: <Phone className="w-5 h-5" />,
                    color: 'text-purple-600',
                    subtext: 'Automated interactions'
                }
            ]);

        } catch (error) {
            console.error('Error fetching data:', error);
        } finally {
            setLoading(false);
        }
    }

    async function assignLeads() {
        if (!assigningTo || selectedLeads.size === 0) return;
        try {
            const { error } = await supabase.from('leads').update({
                assigned_to: assigningTo,
                assigned_at: new Date().toISOString(),
            }).in('id', Array.from(selectedLeads));
            if (error) throw error;
            setSelectedLeads(new Set());
            setAssigningTo('');
            await fetchData();
        } catch (error) {
            console.error('Error assigning leads:', error);
        }
    }

    if (loading) {
        return (
            <div className="space-y-6 animate-fade-in">
                <div className="h-8 w-64 bg-slate-200 rounded-lg animate-pulse" />
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="h-32 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
                    ))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="h-64 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
                    <div className="h-64 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-fade-in pb-12">
            <div className="flex justify-between items-end">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Sales Operations</h1>
                    <p className="text-gray-500 text-sm mt-1">Lead management and team conversion tracking</p>
                </div>
                <div className="text-sm text-gray-400 bg-white px-4 py-2 rounded-xl border border-gray-100 shadow-sm">
                    Live Data Active
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {kpis.map((kpi, i) => (
                    <div key={i} className={`bg-white p-6 rounded-2xl border ${kpi.label === 'Pending Assignment' && Number(kpi.value) > 0 ? 'border-amber-200 shadow-lg shadow-amber-900/5' : 'border-slate-100 shadow-sm'} group transition-all hover:shadow-md`}>
                        <div className="flex items-center justify-between mb-4">
                            <div className={`p-2 rounded-lg bg-slate-50 ${kpi.color}`}>
                                {kpi.icon}
                            </div>
                            <span className={`text-[10px] font-bold uppercase tracking-widest ${kpi.trend === 'up' ? 'text-green-500' : 'text-red-500'}`}>
                                {kpi.change}
                            </span>
                        </div>
                        <p className="text-3xl font-black text-slate-900">{kpi.value}</p>
                        <p className="text-xs text-slate-500 font-medium mt-1 uppercase tracking-tight">{kpi.label}</p>
                        <p className="text-[10px] text-slate-400 mt-2">{kpi.subtext}</p>
                    </div>
                ))}
            </div>

            {/* Charts Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <h3 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
                        <TrendingUp className="w-5 h-5 text-green-500" />
                        Operational Revenue Trend
                    </h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={revenueData}>
                                <defs>
                                    <linearGradient id="colorRevOp" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                <XAxis dataKey="month" tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                                <YAxis tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                                <Tooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }} />
                                <Area type="monotone" dataKey="value" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorRevOp)" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <h3 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
                        <Users className="w-5 h-5 text-blue-500" />
                        Manager Performance
                    </h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={teamPerformance}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                <XAxis dataKey="name" tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                                <YAxis tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                                <Tooltip cursor={{ fill: 'transparent' }} contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }} />
                                <Bar dataKey="conversions" fill="#3b82f6" radius={[6, 6, 0, 0]} barSize={24} />
                                <Bar dataKey="qualified" fill="#8b5cf6" radius={[6, 6, 0, 0]} barSize={24} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>

            {/* Assignment Section */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                    <h2 className="text-lg font-bold text-gray-900">Lead Assignment Pool</h2>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400 font-medium">Auto-Refresh:</span>
                        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                    </div>
                </div>

                {selectedLeads.size > 0 && (
                    <div className="bg-slate-900 text-white p-4 flex items-center justify-between animate-slide-up sticky top-0 z-10">
                        <div className="flex items-center gap-4">
                            <span className="bg-primary-500 text-white font-bold w-6 h-6 rounded-full flex items-center justify-center text-xs">
                                {selectedLeads.size}
                            </span>
                            <span className="text-sm font-medium">Batch assigning leads</span>
                        </div>
                        <div className="flex items-center gap-3">
                            <select
                                value={assigningTo}
                                onChange={(e) => setAssigningTo(e.target.value)}
                                className="bg-slate-800 text-white px-3 py-1.5 rounded-lg text-sm border-none focus:ring-1 focus:ring-primary-500 outline-none"
                            >
                                <option value="">Select Manager...</option>
                                {managers.map(m => (
                                    <option key={m.id} value={m.id}>{m.full_name}</option>
                                ))}
                            </select>
                            <button
                                onClick={assignLeads}
                                disabled={!assigningTo}
                                className="px-4 py-1.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition-colors"
                            >
                                Assign Now
                            </button>
                        </div>
                    </div>
                )}

                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-slate-50/50 border-b border-gray-100">
                            <tr>
                                <th className="px-6 py-4 text-left">
                                    <input
                                        type="checkbox"
                                        checked={selectedLeads.size === leads.length && leads.length > 0}
                                        onChange={(e) => setSelectedLeads(e.target.checked ? new Set(leads.map(l => l.id)) : new Set())}
                                        className="w-4 h-4 rounded text-primary-600 border-slate-300"
                                    />
                                </th>
                                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Lead Identity</th>
                                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
                                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Growth Score</th>
                                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Current Assignment</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {leads.map(lead => (
                                <tr key={lead.id} className="hover:bg-slate-50/50 transition-colors group">
                                    <td className="px-6 py-4">
                                        <input
                                            type="checkbox"
                                            checked={selectedLeads.has(lead.id)}
                                            onChange={() => {
                                                const next = new Set(selectedLeads);
                                                next.has(lead.id) ? next.delete(lead.id) : next.add(lead.id);
                                                setSelectedLeads(next);
                                            }}
                                            className="w-4 h-4 rounded text-primary-600 border-slate-300"
                                        />
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="font-bold text-slate-900 group-hover:text-primary-600 transition-colors">{lead.name}</div>
                                        <div className="text-[10px] text-slate-400">{lead.phone}</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider ${lead.status === 'Converted' ? 'bg-green-100 text-green-700' :
                                            lead.status === 'Qualified' ? 'bg-blue-100 text-blue-700' :
                                                lead.status === 'New' ? 'bg-amber-100 text-amber-700' :
                                                    'bg-slate-100 text-slate-600'
                                            }`}>
                                            {lead.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="flex-1 max-w-[100px] h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                <div className={`h-full transition-all duration-1000 ${lead.score > 70 ? 'bg-green-500' : lead.score > 40 ? 'bg-amber-500' : 'bg-slate-300'}`} style={{ width: `${lead.score}%` }} />
                                            </div>
                                            <span className="text-xs font-bold text-slate-600">{lead.score}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        {lead.assigned_manager_name ? (
                                            <div className="flex items-center gap-2">
                                                <div className="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center text-[10px] font-bold text-slate-500">
                                                    {lead.assigned_manager_name[0]}
                                                </div>
                                                <span className="text-sm text-slate-600">{lead.assigned_manager_name}</span>
                                            </div>
                                        ) : (
                                            <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-100">Unassigned</span>
                                        )}
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
