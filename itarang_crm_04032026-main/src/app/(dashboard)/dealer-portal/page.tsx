'use client';

import {
    Users,
    TrendingUp,
    FileText,
    Zap,
    Plus,
    FileCheck,
    Battery,
    Package,
    AlertCircle,
    CheckCircle2,
    Clock,
    XCircle,
    Megaphone,
    ChevronRight
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';


export default function DealerDashboard() {
    const [stats, setStats] = useState<any>({
        metrics: {
            totalLeads: 0,
            convertedLeads: 0,
            conversionRate: 0,
            commission: 0,
            inventoryCount: 0,
            totalPayments: 0,
            loanCount: 0,
            rewards: 0
        },
        recentLeads: []
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const res = await fetch('/api/dealer/stats');
                const data = await res.json();
                if (data.success) {
                    setStats(data.data);
                }
            } catch (error) {
                console.error('Failed to load stats', error);
            } finally {
                setLoading(false);
            }
        };
        fetchStats();
    }, []);

    const metricsData = stats.metrics;

    const metrics = [
        { title: 'Stock Available', value: `${metricsData.inventoryCount} Units`, trend: '+0%', icon: Package, color: 'text-brand-600', subtext: 'in warehouse', trendColor: 'text-gray-400' },
        { title: 'Stock Deployed', value: '0 EVs', trend: '0', icon: TruckStart, color: 'text-blue-600', subtext: 'on the road', trendColor: 'text-gray-400' },
        { title: 'Delayed Payment', value: '₹ 0', trend: '0%', icon: AlertCircle, color: 'text-red-600', subtext: 'Outstanding', trendColor: 'text-gray-400' },
        { title: 'On-time Payment', value: metricsData.totalPayments > 1000 ? `₹ ${(metricsData.totalPayments / 1000).toFixed(1)}K` : `₹ ${metricsData.totalPayments}`, trend: '+0%', icon: CheckCircle2, color: 'text-green-600', subtext: 'Total Collected', trendColor: 'text-gray-400' },
        { title: 'Total Customers', value: metricsData.totalLeads.toString(), trend: `+${metricsData.totalLeads}`, icon: Users, color: 'text-indigo-600', subtext: 'total leads', trendColor: 'text-green-600' },
        { title: 'Loan Applied', value: metricsData.loanCount.toString(), trend: `+${metricsData.loanCount}`, icon: FileText, color: 'text-orange-600', subtext: 'applications', trendColor: 'text-green-600' },
        { title: 'Loan Cleared', value: '0', trend: '0', icon: CheckCircle2, color: 'text-emerald-600', subtext: 'funded', trendColor: 'text-gray-400' },
        { title: 'KYC Rejected', value: '0', trend: '0', icon: XCircle, color: 'text-red-500', subtext: 'discrepancies', trendColor: 'text-gray-400' },
    ];

    return (
        <div className="space-y-8 animate-in fade-in duration-500 pb-10">
            {/* Header Section */}
            <div>
                <h1 className="text-2xl font-bold text-gray-900">Dealer Dashboard</h1>
                <p className="text-gray-500 mt-1">Overview of your solar & EV business</p>
            </div>

            {/* Quick Action Widgets */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* New Lead - Primary Action */}
                <Link href="/dealer-portal/leads/new" className="group relative overflow-hidden rounded-2xl bg-[#005596] p-6 text-white shadow-lg transition-transform hover:-translate-y-1 hover:shadow-xl">
                    <div className="relative z-10 flex flex-col h-full justify-between min-h-[140px]">
                        <div className="p-3 bg-white/10 w-fit rounded-xl backdrop-blur-sm group-hover:bg-white/20 transition-colors">
                            <Plus className="w-6 h-6" />
                        </div>
                        <div>
                            <h3 className="font-bold text-xl mb-1">New Lead</h3>
                            <p className="text-blue-100 text-sm opacity-90">Create a new customer lead</p>
                        </div>
                    </div>
                    {/* Decorative Background */}
                    <div className="absolute -right-4 -bottom-4 bg-white/5 w-32 h-32 rounded-full blur-2xl group-hover:bg-white/10 transition-colors"></div>
                </Link>

                {/* Process Loan (Loan Facilitation Queue) */}
                <Link href="/dealer-portal/loans/facilitation" className="group relative rounded-2xl bg-white border border-gray-100 p-6 shadow-card hover:shadow-lg transition-transform hover:-translate-y-1">
                    <div className="flex flex-col h-full justify-between min-h-[140px]">
                        <div className="p-3 bg-indigo-50 w-fit rounded-xl text-indigo-600">
                            <FileCheck className="w-6 h-6" />
                        </div>
                        <div>
                            <h3 className="font-bold text-gray-900 text-xl mb-1">Process Loan</h3>
                            <p className="text-gray-500 text-sm">Upload docs for financing</p>
                        </div>
                    </div>
                </Link>

                {/* Add Asset */}
                <Link href="/dealer-portal/assets" className="group relative rounded-2xl bg-white border border-gray-100 p-6 shadow-card hover:shadow-lg transition-transform hover:-translate-y-1">
                    <div className="flex flex-col h-full justify-between min-h-[140px]">
                        <div className="p-3 bg-teal-50 w-fit rounded-xl text-teal-600">
                            <Battery className="w-6 h-6" />
                        </div>
                        <div>
                            <h3 className="font-bold text-gray-900 text-xl mb-1">Add Asset</h3>
                            <p className="text-gray-500 text-sm">Register new vehicle/battery</p>
                        </div>
                    </div>
                </Link>
            </div>

            {/* Stats Grid - 8 items */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {metrics.map((metric, index) => (
                    <div key={index} className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-gray-500 text-sm font-medium">{metric.title}</span>
                            <metric.icon className={`w-4 h-4 ${metric.color}`} />
                        </div>
                        <div className="flex items-end gap-2 mb-2">
                            <span className="text-2xl font-bold text-gray-900">{metric.value}</span>
                            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${metric.trendColor.includes('green') ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                {metric.trend}
                            </span>
                        </div>
                        <p className="text-xs text-gray-400">{metric.subtext}</p>
                    </div>
                ))}
            </div>

            {/* Campaign Banner */}
            <div className="group relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#004e92] to-[#000428] text-white p-8 shadow-lg">
                <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                    <div>
                        <h3 className="text-xl font-bold mb-2">Boost your sales! Send SMS/WhatsApp updates</h3>
                        <p className="text-blue-100 max-w-xl">
                            Reach all your customers instantly for just <span className="font-semibold text-white">₹99/- per month</span>. Drive engagement with targeted campaigns.
                        </p>
                    </div>
                    <Link href="/dealer-portal/campaigns/new" className="whitespace-nowrap bg-white text-blue-900 hover:bg-blue-50 px-6 py-2.5 rounded-full font-semibold shadow-md transition-colors flex items-center gap-2">
                        <Megaphone className="w-4 h-4" />
                        Start Campaign
                    </Link>
                </div>
                {/* Background Decor */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
                <div className="absolute bottom-0 left-0 w-48 h-48 bg-blue-500/20 rounded-full blur-2xl translate-y-1/3 -translate-x-1/4"></div>
            </div>

            {/* Recent Leads Section */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100 flex items-center justify-between">
                    <div>
                        <h3 className="font-bold text-gray-900">Recent Leads</h3>
                        <p className="text-sm text-gray-500">Latest potential customers added</p>
                    </div>
                    <Link href="/dealer-portal/leads" className="text-sm font-medium text-brand-600 hover:text-brand-700 flex items-center gap-1">
                        View All Leads <ChevronRight className="w-4 h-4" />
                    </Link>
                </div>

                <div className="p-2">
                    {loading ? (
                        <div className="p-8 space-y-4">
                            {[1, 2, 3].map(i => <div key={i} className="h-16 bg-gray-50 rounded-xl animate-pulse" />)}
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {/* We will map over leads if they exist, else show mocks if empty for demo */}
                            {stats.recentLeads.length > 0 ? stats.recentLeads.map((lead: any) => (
                                <LeadRow key={lead.id} lead={lead} />
                            )) : (
                                <>
                                    {/* Mock Data for Visualization if API returns empty */}
                                    <MockLeadRow name="Nandhu" status="Cold" color="bg-gray-100 text-gray-700" initial="N" />
                                    <MockLeadRow name="Rakesh" status="Hot" color="bg-red-50 text-red-600" initial="R" />
                                    <MockLeadRow name="Suresh" status="Warm" color="bg-blue-50 text-blue-600" initial="S" />
                                    <MockLeadRow name="Anjali" status="Hot" color="bg-red-50 text-red-600" initial="A" />
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// Icon for Truck
const TruckStart = ({ className }: { className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" />
    </svg>
);

function MockLeadRow({ name, status, color, initial }: any) {
    return (
        <div className="flex items-center justify-between p-4 hover:bg-gray-50 rounded-xl transition-colors cursor-pointer group">
            <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 font-bold">
                    {initial}
                </div>
                <span className="font-medium text-gray-900">{name}</span>
            </div>
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${color}`}>
                {status}
            </span>
        </div>
    );
}

function LeadRow({ lead }: { lead: any }) {
    const getStatusColor = (status: string) => {
        switch (status.toLowerCase()) {
            case 'hot': return 'bg-red-50 text-red-600';
            case 'warm': return 'bg-blue-50 text-blue-600';
            case 'cold': return 'bg-gray-100 text-gray-700';
            default: return 'bg-gray-100 text-gray-600';
        }
    };

    return (
        <Link href={`/dealer-portal/leads?new=${lead.id}`} className="flex items-center justify-between p-4 hover:bg-gray-50 rounded-xl transition-colors cursor-pointer group">
            <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-brand-50 flex items-center justify-center text-brand-600 font-bold text-sm uppercase">
                    {lead.owner_name?.[0] || 'U'}
                </div>
                <div>
                    <p className="font-medium text-gray-900">{lead.owner_name}</p>
                </div>
            </div>
            <span className={`px-3 py-1 rounded-full text-xs font-medium capitalize ${getStatusColor(lead.interest_level || 'new')}`}>
                {lead.interest_level || 'New'}
            </span>
        </Link>
    )
}
