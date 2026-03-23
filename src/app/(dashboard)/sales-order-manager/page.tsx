'use client';

import { useAuth } from '@/components/auth/AuthProvider';
import { KPICard } from '@/components/shared/kpi-card';
import { MetricsChart } from '@/components/shared/charts';
import {
    Package,
    Truck,
    Clock,
    CheckCircle,
    Navigation,
    Boxes,
    BarChart,
    Calendar,
    ArrowRight
} from 'lucide-react';
import { useEffect, useState } from 'react';

export default function SalesOrderManagerDashboard() {
    const { user } = useAuth();
    const [metrics, setMetrics] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchMetrics() {
            try {
                const res = await fetch('/api/dashboard/sales_order_manager');
                const result = await res.json();
                if (result.success) {
                    setMetrics(result.data);
                }
            } catch (err) {
                console.error('Failed to fetch sales order manager metrics:', err);
            } finally {
                setLoading(false);
            }
        }
        fetchMetrics();
    }, []);

    if (loading) return <div className="p-8">Loading Order Data...</div>;

    const kpis = [
        {
            title: 'Orders Pending Dispatch',
            value: '18',
            trend: 3,
            icon: Package,
            suffix: 'Ready to ship'
        },
        {
            title: 'In-Transit Today',
            value: '42',
            trend: 5.4,
            icon: Truck,
            suffix: 'on the move'
        },
        {
            title: 'Avg. Fulfillment Time',
            value: '2.4 Days',
            trend: -8,
            icon: Clock,
            trendPositive: true,
            suffix: 'Order to Dispatch'
        },
        {
            title: 'Successful Deliveries',
            value: '145',
            icon: CheckCircle,
            trend: 22,
            suffix: 'MTD'
        }
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
            <header className="flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900">Sales Order Manager Dashboard</h1>
                    <p className="text-slate-500">Logistics oversight and order fulfillment tracking</p>
                </div>
                <div className="flex gap-2">
                    <button className="px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                        <Calendar className="w-4 h-4" />
                        Schedule Pickup
                    </button>
                    <button className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors">
                        New Dispatch Result
                    </button>
                </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {kpis.map((kpi, i) => (
                    <KPICard key={i} {...kpi} />
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Fulfillment Status Breakdown */}
                <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-semibold mb-6 flex items-center gap-2">
                        <BarChart className="w-5 h-5 text-emerald-600" />
                        Fulfillment Performance (Weekly)
                    </h3>
                    <div className="h-[300px]">
                        <MetricsChart
                            type="bar"
                            data={metrics?.fulfillmentTrend || [
                                { name: 'Mon', Received: 28, Dispatched: 25 },
                                { name: 'Tue', Received: 35, Dispatched: 32 },
                                { name: 'Wed', Received: 42, Dispatched: 38 },
                                { name: 'Thu', Received: 38, Dispatched: 40 },
                                { name: 'Fri', Received: 45, Dispatched: 42 },
                            ]}
                            dataKeys={['Received', 'Dispatched']}
                            categoryKey="name"
                            colors={['#3b82f6', '#10b981']}
                            title="Fulfillment Performance (Weekly)"
                        />
                    </div>
                </div>

                {/* Logistics Partners Stats */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-semibold mb-6 flex items-center gap-2">
                        <Truck className="w-5 h-5 text-emerald-600" />
                        Logistics Efficiency
                    </h3>
                    <div className="space-y-6">
                        {[
                            { name: 'XpressBees', rating: 98, load: 45, color: '#10b981' },
                            { name: 'Delhivery', rating: 94, load: 30, color: '#3b82f6' },
                            { name: 'BlueDart', rating: 99, load: 15, color: '#6366f1' },
                            { name: 'Local Fleet', rating: 92, load: 10, color: '#f59e0b' },
                        ].map((partner) => (
                            <div key={partner.name} className="space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span className="font-medium text-slate-700">{partner.name}</span>
                                    <span className="text-slate-500">{partner.rating}% On-Time</span>
                                </div>
                                <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                                    <div
                                        className="h-1.5 rounded-full"
                                        style={{ width: `${partner.rating}%`, backgroundColor: partner.color }}
                                    ></div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Dispatch Queue Table */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                        <Boxes className="w-5 h-5 text-emerald-600" />
                        Recent High-Priority Dispatches
                    </h3>
                    <button className="text-sm font-medium text-blue-600 hover:underline">View All Orders</button>
                </div>
                <div className="divide-y divide-slate-100">
                    {[
                        { id: 'ORD-8812', destination: 'Noida Hub', items: '25x 48V Batteries', carrier: 'XpressBees', status: 'In Prep' },
                        { id: 'ORD-8815', destination: 'Gurugram Facility', items: '15x L5 Batteries', carrier: 'Delhivery', status: 'Awaiting Pickup' },
                        { id: 'ORD-8819', destination: 'Jaipur Dealer', items: '10x Solar Packs', carrier: 'BlueDart', status: 'Ready' },
                    ].map((order) => (
                        <div key={order.id} className="p-4 flex items-center justify-between hover:bg-slate-50 group">
                            <div className="flex items-center gap-4">
                                <div className="p-2 bg-slate-50 rounded-lg group-hover:bg-white transition-colors">
                                    <Navigation className="w-5 h-5 text-slate-400 group-hover:text-blue-500" />
                                </div>
                                <div>
                                    <div className="font-bold text-slate-900">{order.id}</div>
                                    <div className="text-sm text-slate-500">{order.destination} • {order.items}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-6">
                                <div className="text-right hidden sm:block">
                                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Carrier</div>
                                    <div className="text-sm font-medium text-slate-700">{order.carrier}</div>
                                </div>
                                <div className="px-3 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-bold ring-1 ring-blue-100">
                                    {order.status}
                                </div>
                                <button className="p-2 text-slate-400 hover:text-emerald-600">
                                    <ArrowRight className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
