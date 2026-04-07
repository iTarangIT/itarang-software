'use client';

import { useState } from 'react';
import {
    ShoppingCart, Package, Truck, Clock, CheckCircle2,
    AlertTriangle, Search, Filter, Plus, ArrowRight,
    Landmark, BarChart3, Bell, FileText,
} from 'lucide-react';

type Order = {
    id: string;
    product_name: string;
    quantity: number;
    unit_price: number;
    total_amount: number;
    status: 'pending' | 'confirmed' | 'dispatched' | 'delivered' | 'cancelled';
    ordered_at: string;
    expected_delivery: string | null;
};

const MOCK_ORDERS: Order[] = [
    {
        id: 'ORD-001',
        product_name: 'iTarang EV Battery 48V 30Ah',
        quantity: 10,
        unit_price: 28000,
        total_amount: 280000,
        status: 'delivered',
        ordered_at: '2026-03-15T10:30:00Z',
        expected_delivery: '2026-03-22T10:30:00Z',
    },
    {
        id: 'ORD-002',
        product_name: 'iTarang EV Battery 60V 24Ah',
        quantity: 5,
        unit_price: 35000,
        total_amount: 175000,
        status: 'dispatched',
        ordered_at: '2026-04-01T08:00:00Z',
        expected_delivery: '2026-04-08T08:00:00Z',
    },
    {
        id: 'ORD-003',
        product_name: 'iTarang Charger Unit 48V',
        quantity: 20,
        unit_price: 3500,
        total_amount: 70000,
        status: 'confirmed',
        ordered_at: '2026-04-05T14:00:00Z',
        expected_delivery: '2026-04-12T14:00:00Z',
    },
    {
        id: 'ORD-004',
        product_name: 'iTarang EV Battery 48V 30Ah',
        quantity: 15,
        unit_price: 28000,
        total_amount: 420000,
        status: 'pending',
        ordered_at: '2026-04-07T09:00:00Z',
        expected_delivery: null,
    },
];

const STATUS_FILTERS = ['all', 'pending', 'confirmed', 'dispatched', 'delivered', 'cancelled'] as const;

export default function OrdersPage() {
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('all');

    const orders = MOCK_ORDERS.filter(o => {
        if (statusFilter !== 'all' && o.status !== statusFilter) return false;
        if (search && !o.product_name.toLowerCase().includes(search.toLowerCase()) && !o.id.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const totalOrders = MOCK_ORDERS.length;
    const pendingOrders = MOCK_ORDERS.filter(o => o.status === 'pending').length;
    const inTransit = MOCK_ORDERS.filter(o => o.status === 'dispatched').length;
    const delivered = MOCK_ORDERS.filter(o => o.status === 'delivered').length;

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Orders from OEM</h1>
                    <p className="mt-1 text-gray-500">Track your product orders, deliveries, and procurement history.</p>
                </div>
                <button className="inline-flex items-center gap-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white px-4 py-2.5 text-sm font-semibold transition-colors">
                    <Plus className="h-4 w-4" /> New Order
                </button>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard icon={<ShoppingCart className="h-5 w-5" />} title="Total Orders" value={totalOrders} tone="blue" />
                <KpiCard icon={<Clock className="h-5 w-5" />} title="Pending" value={pendingOrders} tone="yellow" />
                <KpiCard icon={<Truck className="h-5 w-5" />} title="In Transit" value={inTransit} tone="indigo" />
                <KpiCard icon={<CheckCircle2 className="h-5 w-5" />} title="Delivered" value={delivered} tone="green" />
            </div>

            {/* Search & Filter */}
            <div className="flex flex-col md:flex-row gap-3">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                        type="text"
                        placeholder="Search by product or order ID..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                    />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <Filter className="h-4 w-4 text-gray-400" />
                    {STATUS_FILTERS.map(f => (
                        <button
                            key={f}
                            onClick={() => setStatusFilter(f)}
                            className={`px-3 py-1.5 rounded-full text-xs font-semibold border capitalize transition-colors ${statusFilter === f ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                        >
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            {/* Orders Table */}
            <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
                <div className="p-5 border-b border-gray-100 flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-blue-50 text-blue-600"><Package className="h-5 w-5" /></div>
                    <div>
                        <h2 className="font-bold text-gray-900">Order History</h2>
                        <p className="text-sm text-gray-500">Click an order to view details</p>
                    </div>
                </div>

                {orders.length === 0 ? (
                    <div className="p-8 text-center text-sm text-gray-500">No orders found for this filter.</div>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {orders.map(order => (
                            <div key={order.id} className="p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4 hover:bg-gray-50 transition-colors cursor-pointer">
                                <div className="min-w-0">
                                    <div className="font-semibold text-gray-900">
                                        {order.product_name}
                                        <span className="ml-2 text-gray-400 font-medium text-sm">{order.id}</span>
                                    </div>
                                    <div className="mt-1 text-sm text-gray-500">
                                        Qty: {order.quantity} &middot; ₹{order.unit_price.toLocaleString()} each &middot; Ordered: {new Date(order.ordered_at).toLocaleDateString()}
                                    </div>
                                    <div className="mt-2">
                                        <StatusBadge status={order.status} />
                                    </div>
                                </div>
                                <div className="text-right shrink-0">
                                    <div className="text-xs text-gray-400">Total</div>
                                    <div className="text-lg font-bold text-gray-900">₹{order.total_amount.toLocaleString()}</div>
                                    {order.expected_delivery && (
                                        <div className="text-xs text-gray-500 mt-1">
                                            ETA: {new Date(order.expected_delivery).toLocaleDateString()}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Future Roadmap */}
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-6">
                <div className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-3">Coming Soon</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <FutureItem icon={<Landmark className="h-4 w-4" />} text="Direct OEM catalog integration for one-click ordering" />
                    <FutureItem icon={<Truck className="h-4 w-4" />} text="Real-time shipment tracking with logistics partner APIs" />
                    <FutureItem icon={<Bell className="h-4 w-4" />} text="Low stock alerts with auto-reorder suggestions" />
                    <FutureItem icon={<FileText className="h-4 w-4" />} text="Purchase order PDF generation & digital signatures" />
                </div>
            </div>
        </div>
    );
}

function KpiCard({ icon, title, value, tone }: { icon: React.ReactNode; title: string; value: number; tone: string }) {
    const colors: Record<string, string> = {
        blue: 'bg-blue-50 text-blue-600',
        yellow: 'bg-yellow-50 text-yellow-600',
        indigo: 'bg-indigo-50 text-indigo-600',
        green: 'bg-green-50 text-green-600',
    };
    return (
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
                <div className={`rounded-xl p-2 ${colors[tone]}`}>{icon}</div>
                <div>
                    <div className="text-2xl font-extrabold text-gray-900">{value}</div>
                    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</div>
                </div>
            </div>
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        pending: 'bg-yellow-50 text-yellow-700',
        confirmed: 'bg-blue-50 text-blue-700',
        dispatched: 'bg-indigo-50 text-indigo-700',
        delivered: 'bg-green-50 text-green-700',
        cancelled: 'bg-red-50 text-red-700',
    };
    return (
        <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold capitalize ${map[status] || 'bg-gray-100 text-gray-600'}`}>
            {status}
        </span>
    );
}

function FutureItem({ icon, text }: { icon: React.ReactNode; text: string }) {
    return (
        <div className="flex items-start gap-2 text-sm text-gray-600">
            <div className="mt-0.5 text-gray-400">{icon}</div>
            <span>{text}</span>
        </div>
    );
}
