'use client';

import { KPICard } from '@/components/shared/kpi-card';
import { MetricsChart } from '@/components/shared/charts';
import { DataTable } from '@/components/shared/data-table';
import {
    FileText,
    AlertTriangle,
    CheckCircle2,
    DollarSign,
    Wallet,
    Clock,
    ArrowRight
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/dashboard/ErrorBoundary';

export default function FinanceControllerDashboard() {
    const { data: metricsResponse, isLoading } = useQuery({
        queryKey: ['dashboard', 'finance_controller'],
        queryFn: async () => {
            const res = await fetch('/api/dashboard/finance_controller');
            if (!res.ok) throw new Error('Failed to fetch metrics');
            return res.json();
        }
    });

    const metrics = metricsResponse?.data;

    if (isLoading) return <div className="p-8 text-center text-slate-500">Loading Financial Data...</div>;

    const kpis = [
        {
            title: 'Pending L3 Approvals',
            value: metrics?.pendingApprovals?.toString() || '0',
            trend: 0,
            icon: FileText,
            suffix: 'Requires Invoice Issue'
        },
        {
            title: 'Receivables Total',
            value: metrics?.receivablesTotal ? `₹${(parseFloat(metrics.receivablesTotal) / 100000).toFixed(1)} Lakh` : '₹0',
            trend: -4.2,
            icon: Wallet,
            trendPositive: true,
            suffix: 'unpaid total'
        },
        {
            title: 'Unpaid Orders',
            value: metrics?.unpaidOrders?.toString() || '0',
            trend: 8.1,
            icon: AlertTriangle,
            trendPositive: false,
            suffix: 'Critical Attention'
        },
        {
            title: 'Invoices Issued (MTD)',
            value: '42', // Mock for now
            icon: CheckCircle2,
            trend: 14,
            suffix: '+5 since yesterday'
        }
    ];

    const invoicingColumns = [
        { header: 'Deal ID', accessor: 'id' },
        { header: 'Customer / OEM', accessor: 'name' },
        {
            header: 'Amount',
            accessor: 'amount',
            render: (val: any) => <span className="font-bold text-slate-900">₹{parseFloat(val).toLocaleString()}</span>
        },
        {
            header: 'Approval Date',
            accessor: 'date',
            render: (val: string) => new Date(val).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        },
        {
            header: 'Action',
            accessor: 'id',
            textRight: true,
            render: () => (
                <button className="px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-md text-xs font-bold hover:bg-emerald-100 transition-colors inline-flex items-center gap-1">
                    Generate Invoice <ArrowRight className="w-3 h-3" />
                </button>
            )
        },
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
            <header className="flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900">Finance Controller Dashboard</h1>
                    <p className="text-slate-500">Invoice management and payment tracking</p>
                </div>
                <div className="flex gap-3">
                    <button className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors">
                        <DollarSign className="w-4 h-4" />
                        Record Payment
                    </button>
                </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {kpis.map((kpi, i) => (
                    <KPICard key={i} {...kpi} />
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Aging of Receivables */}
                <div className="lg:col-span-2">
                    <ErrorBoundary title="Receivables Aging Failed">
                        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                            <h3 className="text-lg font-semibold mb-6 flex items-center gap-2">
                                <Clock className="w-5 h-5 text-emerald-600" />
                                Aging of Receivables (Summary)
                            </h3>
                            <div className="h-[300px]">
                                <MetricsChart
                                    type="bar"
                                    data={metrics?.agingData || []}
                                    dataKeys={['amount']}
                                    categoryKey="name"
                                    colors={['#10b981']}
                                    title="Aging of Receivables (Summary)"
                                />
                            </div>
                        </div>
                    </ErrorBoundary>
                </div>

                {/* Credit Limit Alerts */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-semibold mb-6 flex items-center gap-2 text-rose-600">
                        <AlertTriangle className="w-5 h-5" />
                        Credit Limit Warnings
                    </h3>
                    <div className="space-y-4">
                        {[
                            { name: 'Kisan EV Hub', used: 92, limit: '₹15L' },
                            { name: 'Metro E-Auto', used: 88, limit: '₹10L' },
                            { name: 'Urban Green', used: 85, limit: '₹12L' },
                        ].map((dealer) => (
                            <div key={dealer.name} className="space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span className="font-medium text-slate-700">{dealer.name}</span>
                                    <span className="text-slate-500">{dealer.used}% of {dealer.limit}</span>
                                </div>
                                <div className="w-full bg-slate-100 rounded-full h-2">
                                    <div
                                        className={`h-2 rounded-full ${dealer.used > 90 ? 'bg-rose-500' : 'bg-amber-500'}`}
                                        style={{ width: `${dealer.used}%` }}
                                    ></div>
                                </div>
                            </div>
                        ))}
                    </div>
                    <button className="w-full mt-6 py-2 text-sm text-slate-600 font-medium hover:text-emerald-600 transition-colors">
                        View All Dealer Credits →
                    </button>
                </div>
            </div>

            {/* Invoicing Queue Table */}
            <ErrorBoundary title="Invoicing Queue Failed">
                <DataTable
                    title="Ready for Individual Invoicing (Approved Deals)"
                    columns={invoicingColumns}
                    data={metrics?.invoicingQueue || []}
                    searchPlaceholder="Search deals..."
                />
            </ErrorBoundary>
        </div>
    );
}
