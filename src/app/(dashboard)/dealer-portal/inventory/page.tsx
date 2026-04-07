'use client';

import { useState, useEffect } from 'react';
import {
    Package, Search, Filter, Plus, AlertTriangle,
    CheckCircle2, Loader2, BarChart3, Truck, Bell,
    QrCode, Download,
} from 'lucide-react';

type InventoryItem = {
    id: string;
    product_name: string;
    sku: string;
    category: string;
    quantity_available: number;
    quantity_reserved: number;
    quantity_sold: number;
    unit_price: number;
    warehouse_location: string;
    last_restocked: string;
    status: 'in_stock' | 'low_stock' | 'out_of_stock';
};

const MOCK_INVENTORY: InventoryItem[] = [
    {
        id: 'INV-001', product_name: 'iTarang EV Battery 48V 30Ah', sku: 'BAT-48-30',
        category: 'Battery', quantity_available: 24, quantity_reserved: 3, quantity_sold: 48,
        unit_price: 28000, warehouse_location: 'Warehouse A', last_restocked: '2026-04-01',
        status: 'in_stock',
    },
    {
        id: 'INV-002', product_name: 'iTarang EV Battery 60V 24Ah', sku: 'BAT-60-24',
        category: 'Battery', quantity_available: 8, quantity_reserved: 2, quantity_sold: 15,
        unit_price: 35000, warehouse_location: 'Warehouse A', last_restocked: '2026-03-20',
        status: 'in_stock',
    },
    {
        id: 'INV-003', product_name: 'iTarang Charger Unit 48V', sku: 'CHR-48',
        category: 'Charger', quantity_available: 3, quantity_reserved: 1, quantity_sold: 30,
        unit_price: 3500, warehouse_location: 'Warehouse B', last_restocked: '2026-03-10',
        status: 'low_stock',
    },
    {
        id: 'INV-004', product_name: 'iTarang Controller Unit V2', sku: 'CTR-V2',
        category: 'Controller', quantity_available: 0, quantity_reserved: 0, quantity_sold: 12,
        unit_price: 8500, warehouse_location: 'Warehouse A', last_restocked: '2026-02-15',
        status: 'out_of_stock',
    },
    {
        id: 'INV-005', product_name: 'iTarang EV Battery 72V 40Ah', sku: 'BAT-72-40',
        category: 'Battery', quantity_available: 12, quantity_reserved: 0, quantity_sold: 6,
        unit_price: 45000, warehouse_location: 'Warehouse A', last_restocked: '2026-04-03',
        status: 'in_stock',
    },
];

const CATEGORY_FILTERS = ['all', 'Battery', 'Charger', 'Controller'] as const;

export default function InventoryPage() {
    const [search, setSearch] = useState('');
    const [categoryFilter, setCategoryFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('all');

    const items = MOCK_INVENTORY.filter(item => {
        if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
        if (statusFilter !== 'all' && item.status !== statusFilter) return false;
        if (search && !item.product_name.toLowerCase().includes(search.toLowerCase()) && !item.sku.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const totalItems = MOCK_INVENTORY.reduce((s, i) => s + i.quantity_available, 0);
    const totalValue = MOCK_INVENTORY.reduce((s, i) => s + i.quantity_available * i.unit_price, 0);
    const lowStockCount = MOCK_INVENTORY.filter(i => i.status === 'low_stock').length;
    const outOfStockCount = MOCK_INVENTORY.filter(i => i.status === 'out_of_stock').length;

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
                    <p className="mt-1 text-gray-500">Manage stock levels, track products, and monitor warehouse operations.</p>
                </div>
                <div className="flex gap-2">
                    <button className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors">
                        <Download className="h-4 w-4" /> Export
                    </button>
                    <button className="inline-flex items-center gap-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white px-4 py-2.5 text-sm font-semibold transition-colors">
                        <Plus className="h-4 w-4" /> Add Stock
                    </button>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard icon={<Package className="h-5 w-5" />} title="Total Units" value={totalItems.toString()} tone="blue" />
                <KpiCard icon={<BarChart3 className="h-5 w-5" />} title="Stock Value" value={`₹${(totalValue / 100000).toFixed(1)}L`} tone="green" />
                <KpiCard icon={<AlertTriangle className="h-5 w-5" />} title="Low Stock" value={lowStockCount.toString()} tone="yellow" />
                <KpiCard icon={<AlertTriangle className="h-5 w-5" />} title="Out of Stock" value={outOfStockCount.toString()} tone="red" />
            </div>

            {/* Search & Filter */}
            <div className="flex flex-col md:flex-row gap-3">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                        type="text"
                        placeholder="Search by product name or SKU..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                    />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <Filter className="h-4 w-4 text-gray-400" />
                    {CATEGORY_FILTERS.map(f => (
                        <button
                            key={f}
                            onClick={() => setCategoryFilter(f)}
                            className={`px-3 py-1.5 rounded-full text-xs font-semibold border capitalize transition-colors ${categoryFilter === f ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                        >
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            {/* Inventory Table */}
            <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-gray-100 bg-gray-50">
                                <th className="px-5 py-3 text-left font-semibold text-gray-600">Product</th>
                                <th className="px-5 py-3 text-left font-semibold text-gray-600">SKU</th>
                                <th className="px-5 py-3 text-center font-semibold text-gray-600">Available</th>
                                <th className="px-5 py-3 text-center font-semibold text-gray-600">Reserved</th>
                                <th className="px-5 py-3 text-center font-semibold text-gray-600">Sold</th>
                                <th className="px-5 py-3 text-right font-semibold text-gray-600">Unit Price</th>
                                <th className="px-5 py-3 text-center font-semibold text-gray-600">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {items.map(item => (
                                <tr key={item.id} className="hover:bg-gray-50 transition-colors cursor-pointer">
                                    <td className="px-5 py-4">
                                        <div className="font-semibold text-gray-900">{item.product_name}</div>
                                        <div className="text-xs text-gray-400">{item.warehouse_location}</div>
                                    </td>
                                    <td className="px-5 py-4 text-gray-600 font-mono text-xs">{item.sku}</td>
                                    <td className="px-5 py-4 text-center font-bold text-gray-900">{item.quantity_available}</td>
                                    <td className="px-5 py-4 text-center text-gray-500">{item.quantity_reserved}</td>
                                    <td className="px-5 py-4 text-center text-gray-500">{item.quantity_sold}</td>
                                    <td className="px-5 py-4 text-right font-semibold text-gray-900">₹{item.unit_price.toLocaleString()}</td>
                                    <td className="px-5 py-4 text-center">
                                        <StockBadge status={item.status} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {items.length === 0 && (
                    <div className="p-8 text-center text-sm text-gray-500">No items found.</div>
                )}
            </div>

            {/* Future Roadmap */}
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-6">
                <div className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-3">Coming Soon</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <FutureItem icon={<QrCode className="h-4 w-4" />} text="QR code scanning for instant stock check-in/check-out" />
                    <FutureItem icon={<Bell className="h-4 w-4" />} text="Automated low-stock alerts with auto-reorder triggers" />
                    <FutureItem icon={<Truck className="h-4 w-4" />} text="Multi-warehouse transfer management" />
                    <FutureItem icon={<BarChart3 className="h-4 w-4" />} text="Inventory analytics with demand forecasting" />
                </div>
            </div>
        </div>
    );
}

function KpiCard({ icon, title, value, tone }: { icon: React.ReactNode; title: string; value: string; tone: string }) {
    const colors: Record<string, string> = { blue: 'bg-blue-50 text-blue-600', green: 'bg-green-50 text-green-600', yellow: 'bg-yellow-50 text-yellow-600', red: 'bg-red-50 text-red-600' };
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

function StockBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        in_stock: 'bg-green-50 text-green-700',
        low_stock: 'bg-yellow-50 text-yellow-700',
        out_of_stock: 'bg-red-50 text-red-700',
    };
    const labels: Record<string, string> = { in_stock: 'In Stock', low_stock: 'Low Stock', out_of_stock: 'Out of Stock' };
    return (
        <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${map[status] || 'bg-gray-100 text-gray-600'}`}>
            {labels[status] || status}
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
