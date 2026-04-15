'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
    Loader2, Search, Plus, Eye, ChevronDown,
    Ticket, Package, AlertTriangle,
} from 'lucide-react';

type BatchSummary = {
    id: string;
    name: string;
    dealer_id: string;
    dealer_name: string | null;
    prefix: string;
    coupon_value: string;
    total_quantity: number;
    expiry_date: string | null;
    status: string;
    created_at: string;
    stats: {
        available: number;
        reserved: number;
        used: number;
        expired: number;
        revoked: number;
    };
};

type Pagination = {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
};

const STATUS_COLORS: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-700',
    expired: 'bg-red-100 text-red-700',
    revoked: 'bg-gray-100 text-gray-600',
};

export default function CouponManagementPage() {
    const router = useRouter();
    const [batches, setBatches] = useState<BatchSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
    const [filterStatus, setFilterStatus] = useState('');
    const [searchDealer, setSearchDealer] = useState('');

    const fetchBatches = async (page = 1) => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page), limit: '20' });
            if (filterStatus) params.set('status', filterStatus);
            if (searchDealer) params.set('dealer_id', searchDealer);

            const res = await fetch(`/api/admin/coupons/batches?${params}`);
            const data = await res.json();
            if (data.success) {
                setBatches(data.data);
                setPagination(data.pagination);
            }
        } catch { /* silent */ }
        finally { setLoading(false); }
    };

    useEffect(() => { fetchBatches(); }, [filterStatus]);

    return (
        <div className="min-h-screen bg-[#F8F9FA] p-6">
            <div className="max-w-7xl mx-auto space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                            <Ticket className="w-6 h-6 text-teal-600" />
                            Coupon Management
                        </h1>
                        <p className="text-sm text-gray-500 mt-1">Manage verification coupon batches for dealers</p>
                    </div>
                    <button
                        onClick={() => router.push('/admin/coupon-management/create')}
                        className="px-5 py-2.5 bg-teal-600 text-white rounded-xl text-sm font-bold hover:bg-teal-700 transition-all flex items-center gap-2"
                    >
                        <Plus className="w-4 h-4" />
                        Create New Batch
                    </button>
                </div>

                {/* Filters */}
                <div className="flex items-center gap-3">
                    <div className="relative flex-1 max-w-xs">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search by dealer..."
                            value={searchDealer}
                            onChange={e => setSearchDealer(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && fetchBatches()}
                            className="w-full h-10 pl-10 pr-4 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-teal-500 transition"
                        />
                    </div>
                    <select
                        value={filterStatus}
                        onChange={e => setFilterStatus(e.target.value)}
                        className="h-10 px-4 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-teal-500 transition"
                    >
                        <option value="">All Status</option>
                        <option value="active">Active</option>
                        <option value="expired">Expired</option>
                        <option value="revoked">Revoked</option>
                    </select>
                </div>

                {/* Batch Table */}
                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
                    </div>
                ) : batches.length === 0 ? (
                    <div className="text-center py-20 text-gray-400">
                        <Package className="w-12 h-12 mx-auto mb-3 opacity-50" />
                        <p className="text-sm font-medium">No batches found</p>
                    </div>
                ) : (
                    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50/50">
                                        <th className="text-left px-4 py-3 font-semibold text-gray-600">Batch ID</th>
                                        <th className="text-left px-4 py-3 font-semibold text-gray-600">Dealer</th>
                                        <th className="text-left px-4 py-3 font-semibold text-gray-600">Value</th>
                                        <th className="text-center px-4 py-3 font-semibold text-gray-600">Total</th>
                                        <th className="text-center px-4 py-3 font-semibold text-gray-600">Available</th>
                                        <th className="text-center px-4 py-3 font-semibold text-gray-600">Used</th>
                                        <th className="text-center px-4 py-3 font-semibold text-gray-600">Status</th>
                                        <th className="text-left px-4 py-3 font-semibold text-gray-600">Created</th>
                                        <th className="text-left px-4 py-3 font-semibold text-gray-600">Expiry</th>
                                        <th className="text-center px-4 py-3 font-semibold text-gray-600">Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {batches.map(batch => (
                                        <tr key={batch.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition">
                                            <td className="px-4 py-3 font-mono text-xs text-gray-700">{batch.id}</td>
                                            <td className="px-4 py-3 text-gray-800 font-medium">{batch.dealer_name || batch.dealer_id}</td>
                                            <td className="px-4 py-3 text-gray-700">{Number(batch.coupon_value) === 0 ? 'Free' : `₹${batch.coupon_value}`}</td>
                                            <td className="px-4 py-3 text-center font-semibold text-gray-800">{batch.total_quantity}</td>
                                            <td className="px-4 py-3 text-center">
                                                <span className="text-emerald-600 font-semibold">{batch.stats.available}</span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className="text-blue-600 font-semibold">{batch.stats.used}</span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-bold ${STATUS_COLORS[batch.status] || 'bg-gray-100 text-gray-600'}`}>
                                                    {batch.status}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-xs text-gray-500">
                                                {new Date(batch.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                                            </td>
                                            <td className="px-4 py-3 text-xs text-gray-500">
                                                {batch.expiry_date
                                                    ? new Date(batch.expiry_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                                                    : 'No Expiry'}
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <button
                                                    onClick={() => router.push(`/admin/coupon-management/${batch.id}`)}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal-50 text-teal-700 rounded-lg text-xs font-bold hover:bg-teal-100 transition"
                                                >
                                                    <Eye className="w-3.5 h-3.5" />
                                                    View
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Pagination */}
                        {pagination.totalPages > 1 && (
                            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
                                <p className="text-xs text-gray-500">
                                    Showing {((pagination.page - 1) * pagination.limit) + 1}-{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
                                </p>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => fetchBatches(pagination.page - 1)}
                                        disabled={pagination.page <= 1}
                                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50 transition"
                                    >
                                        Prev
                                    </button>
                                    <span className="px-3 py-1.5 text-xs text-gray-600">Page {pagination.page}/{pagination.totalPages}</span>
                                    <button
                                        onClick={() => fetchBatches(pagination.page + 1)}
                                        disabled={pagination.page >= pagination.totalPages}
                                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50 transition"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
