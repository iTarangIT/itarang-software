'use client';

import { useState, useEffect, useMemo } from 'react';
import {
    Package, Search, Filter, Plus, AlertTriangle,
    BarChart3, Truck, Bell,
    QrCode, Download,
} from 'lucide-react';
import DealerInventoryDetailModal from '@/components/dealer-dashboard/DealerInventoryDetailModal';

type InventoryItem = {
    id: string;
    product_name: string;
    sku: string;
    category: string;
    quantity_available: number;
    quantity_reserved: number;
    quantity_sold: number;
    unit_price: number;
    warehouse_location: string | null;
    received_at: string | null;
    is_new: boolean;
    status: 'in_stock' | 'low_stock' | 'out_of_stock';
};

type IncomingTransfer = {
    id: string;
    source_dealer_id: string;
    target_dealer_id: string;
    serials: string[];
    reason: string | null;
    status: string;
    initiated_at: string;
};

const CATEGORY_FILTERS = ['all', 'Battery', 'Charger', 'Paraphernalia'] as const;

function categoryLabel(raw: string | null | undefined): string {
    if (!raw) return '—';
    const t = String(raw).trim().toLowerCase();
    if (t === 'battery') return 'Battery';
    if (t === 'charger') return 'Charger';
    if (t === 'paraphernalia') return 'Paraphernalia';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function fmtDate(iso: string | null) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
        return iso;
    }
}

function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function buildInventoryCsv(rows: InventoryItem[]): string {
    const headers = [
        'Product',
        'Inventory Detail',
        'Warehouse',
        'Available',
        'Reserved',
        'Sold',
        'Unit Price (INR)',
        'Stock Value (INR)',
        'Received',
        'Status',
    ];
    const body = rows.map(r => [
        r.product_name,
        categoryLabel(r.category),
        r.warehouse_location ?? '',
        r.quantity_available,
        r.quantity_reserved,
        r.quantity_sold,
        r.unit_price,
        r.unit_price * r.quantity_available,
        r.received_at ? new Date(r.received_at).toISOString().slice(0, 10) : '',
        r.status,
    ].map(csvEscape).join(','));
    return [headers.join(','), ...body].join('\r\n');
}

function downloadCsv(filename: string, csv: string) {
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export default function InventoryPage() {
    const [search, setSearch] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<string>('all');
    const [statusFilter] = useState('all');
    const [incoming, setIncoming] = useState<IncomingTransfer[]>([]);
    const [loadingIncoming, setLoadingIncoming] = useState(true);
    const [acking, setAcking] = useState<string | null>(null);
    const [incomingError, setIncomingError] = useState<string | null>(null);

    const [inventory, setInventory] = useState<InventoryItem[]>([]);
    const [loadingInventory, setLoadingInventory] = useState(true);
    const [inventoryError, setInventoryError] = useState<string | null>(null);
    const [activeItem, setActiveItem] = useState<InventoryItem | null>(null);

    const loadIncomingTransfers = async () => {
        setLoadingIncoming(true);
        setIncomingError(null);
        try {
            const res = await fetch('/api/dealer/inventory/acknowledge-transfer?status=pending_acknowledgement');
            const json = await res.json();
            if (json.success) {
                setIncoming(json.data?.rows || []);
            } else {
                setIncomingError(json.error?.message || 'Failed to load incoming transfers');
            }
        } catch {
            setIncomingError('Failed to load incoming transfers');
        } finally {
            setLoadingIncoming(false);
        }
    };

    const loadInventory = async () => {
        setLoadingInventory(true);
        setInventoryError(null);
        try {
            const res = await fetch('/api/dealer/inventory');
            const json = await res.json();
            if (json.success) {
                setInventory(json.data?.rows || []);
            } else {
                setInventoryError(json.error?.message || 'Failed to load inventory');
            }
        } catch {
            setInventoryError('Failed to load inventory');
        } finally {
            setLoadingInventory(false);
        }
    };

    useEffect(() => {
        loadIncomingTransfers();
        loadInventory();
    }, []);

    const acknowledgeTransfer = async (transferId: string) => {
        setAcking(transferId);
        setIncomingError(null);
        try {
            const res = await fetch('/api/dealer/inventory/acknowledge-transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transferId }),
            });
            const json = await res.json();
            if (!json.success) {
                setIncomingError(json.error?.message || 'Failed to acknowledge transfer');
                return;
            }
            await Promise.all([loadIncomingTransfers(), loadInventory()]);
        } catch {
            setIncomingError('Failed to acknowledge transfer');
        } finally {
            setAcking(null);
        }
    };

    const items = useMemo(() => inventory.filter(item => {
        if (
            categoryFilter !== 'all' &&
            (item.category ?? '').toLowerCase() !== categoryFilter.toLowerCase()
        ) {
            return false;
        }
        if (statusFilter !== 'all' && item.status !== statusFilter) return false;
        if (search) {
            const q = search.toLowerCase();
            if (
                !item.product_name.toLowerCase().includes(q) &&
                !item.sku.toLowerCase().includes(q) &&
                !categoryLabel(item.category).toLowerCase().includes(q)
            ) {
                return false;
            }
        }
        return true;
    }), [inventory, categoryFilter, statusFilter, search]);

    const totalItems = inventory.reduce((s, i) => s + i.quantity_available, 0);
    const totalValue = inventory.reduce((s, i) => s + i.quantity_available * i.unit_price, 0);
    const lowStockCount = inventory.filter(i => i.status === 'low_stock').length;
    const outOfStockCount = inventory.filter(i => i.status === 'out_of_stock').length;

    return (
        <div className="space-y-6">
            <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-bold text-blue-900">Incoming Transfers</h2>
                        <p className="text-xs text-blue-700">Acknowledge incoming inventory so units move to available stock.</p>
                    </div>
                    <button
                        onClick={loadIncomingTransfers}
                        className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                    >
                        Refresh
                    </button>
                </div>
                {incomingError && (
                    <p className="mt-2 text-xs text-red-600">{incomingError}</p>
                )}
                {loadingIncoming ? (
                    <div className="mt-3 text-xs text-blue-700">Loading incoming transfers…</div>
                ) : incoming.length === 0 ? (
                    <div className="mt-3 text-xs text-blue-700">No incoming transfers pending acknowledgement.</div>
                ) : (
                    <div className="mt-3 space-y-2">
                        {incoming.map((t) => (
                            <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-blue-100 bg-white p-3">
                                <div>
                                    <div className="text-xs font-bold text-gray-900">{t.id}</div>
                                    <div className="text-xs text-gray-600">
                                        {Array.isArray(t.serials) ? t.serials.length : 0} serial(s) · {new Date(t.initiated_at).toLocaleDateString()}
                                    </div>
                                    {t.reason && <div className="text-xs text-gray-500 mt-0.5">{t.reason}</div>}
                                </div>
                                <button
                                    disabled={acking === t.id}
                                    onClick={() => acknowledgeTransfer(t.id)}
                                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                                >
                                    {acking === t.id ? 'Acknowledging…' : 'Acknowledge'}
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
                    <p className="mt-1 text-gray-500">Manage stock levels, track products, and monitor warehouse operations.</p>
                </div>
                <div className="flex gap-2">
                    <button
                        type="button"
                        disabled={items.length === 0}
                        onClick={() => {
                            const csv = buildInventoryCsv(items);
                            const stamp = new Date().toISOString().slice(0, 10);
                            const scope = categoryFilter === 'all' ? 'all' : categoryFilter.toLowerCase();
                            downloadCsv(`inventory-${scope}-${stamp}.csv`, csv);
                        }}
                        className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors"
                    >
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
                <KpiCard icon={<BarChart3 className="h-5 w-5" />} title="Stock Value" value={totalValue > 0 ? `₹${(totalValue / 100000).toFixed(1)}L` : '₹0'} tone="green" />
                <KpiCard icon={<AlertTriangle className="h-5 w-5" />} title="Low Stock" value={lowStockCount.toString()} tone="yellow" />
                <KpiCard icon={<AlertTriangle className="h-5 w-5" />} title="Out of Stock" value={outOfStockCount.toString()} tone="red" />
            </div>

            {/* Search & Filter */}
            <div className="flex flex-col md:flex-row gap-3">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                        type="text"
                        placeholder="Search by product or inventory detail..."
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

            {inventoryError && (
                <div className="rounded-xl border border-red-100 bg-red-50 p-3 text-xs text-red-700">
                    {inventoryError}
                </div>
            )}

            {/* Inventory Table */}
            <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-gray-100 bg-gray-50">
                                <th className="px-5 py-3 text-left font-semibold text-gray-600">Product</th>
                                <th className="px-5 py-3 text-left font-semibold text-gray-600">Inventory Detail</th>
                                <th className="px-5 py-3 text-center font-semibold text-gray-600">Available</th>
                                <th className="px-5 py-3 text-center font-semibold text-gray-600">Reserved</th>
                                <th className="px-5 py-3 text-center font-semibold text-gray-600">Sold</th>
                                <th className="px-5 py-3 text-left font-semibold text-gray-600">Received</th>
                                <th className="px-5 py-3 text-right font-semibold text-gray-600">Unit Price</th>
                                <th className="px-5 py-3 text-center font-semibold text-gray-600">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {items.map(item => (
                                <tr
                                    key={item.id}
                                    onClick={() => setActiveItem(item)}
                                    className="hover:bg-gray-50 transition-colors cursor-pointer"
                                >
                                    <td className="px-5 py-4">
                                        <div className="font-semibold text-gray-900">{item.product_name}</div>
                                        <div className="text-xs text-gray-400">{item.warehouse_location || item.category}</div>
                                    </td>
                                    <td className="px-5 py-4">
                                        <CategoryBadge category={item.category} />
                                    </td>
                                    <td className="px-5 py-4 text-center font-bold text-gray-900">{item.quantity_available}</td>
                                    <td className="px-5 py-4 text-center text-gray-500">{item.quantity_reserved}</td>
                                    <td className="px-5 py-4 text-center text-gray-500">{item.quantity_sold}</td>
                                    <td className="px-5 py-4">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-gray-600">{fmtDate(item.received_at)}</span>
                                            {item.is_new && <NewBadge />}
                                        </div>
                                    </td>
                                    <td className="px-5 py-4 text-right font-semibold text-gray-900">₹{item.unit_price.toLocaleString()}</td>
                                    <td className="px-5 py-4 text-center">
                                        <StockBadge status={item.status} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {loadingInventory ? (
                    <div className="p-8 text-center text-sm text-gray-500">Loading inventory…</div>
                ) : items.length === 0 ? (
                    <div className="p-8 text-center text-sm text-gray-500">
                        {inventory.length === 0
                            ? 'No inventory yet. Admin uploads will appear here once allocated to your account.'
                            : 'No items match your search or filter.'}
                    </div>
                ) : null}
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

            <DealerInventoryDetailModal
                item={activeItem}
                onClose={() => setActiveItem(null)}
            />
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

function CategoryBadge({ category }: { category: string | null | undefined }) {
    const label = categoryLabel(category);
    const map: Record<string, string> = {
        Battery: 'bg-blue-50 text-blue-700 ring-blue-200',
        Charger: 'bg-amber-50 text-amber-700 ring-amber-200',
        Paraphernalia: 'bg-purple-50 text-purple-700 ring-purple-200',
    };
    const cls = map[label] || 'bg-gray-50 text-gray-700 ring-gray-200';
    return (
        <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ring-1 ${cls}`}>
            {label}
        </span>
    );
}

function NewBadge() {
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            NEW
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
