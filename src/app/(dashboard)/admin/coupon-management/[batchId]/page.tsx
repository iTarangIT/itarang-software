'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import {
    Loader2, ArrowLeft, Download, XCircle, Unlock, Search,
    Ticket, AlertTriangle, CheckCircle2, Clock, Ban, Package,
} from 'lucide-react';

type CouponItem = {
    id: string;
    code: string;
    status: string;
    reserved_at: string | null;
    reserved_for_lead_id: string | null;
    used_at: string | null;
    used_by_lead_id: string | null;
    expires_at: string | null;
};

type BatchDetail = {
    batch: {
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
    };
    stats: Record<string, number>;
    totalCoupons: number;
    coupons: CouponItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
};

const STATUS_BADGE: Record<string, { bg: string; icon: React.ReactNode }> = {
    available: { bg: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 className="w-3 h-3" /> },
    reserved: { bg: 'bg-blue-100 text-blue-700', icon: <Clock className="w-3 h-3" /> },
    used: { bg: 'bg-purple-100 text-purple-700', icon: <CheckCircle2 className="w-3 h-3" /> },
    expired: { bg: 'bg-red-100 text-red-700', icon: <XCircle className="w-3 h-3" /> },
    revoked: { bg: 'bg-gray-100 text-gray-600', icon: <Ban className="w-3 h-3" /> },
};

export default function BatchDetailPage({ params }: { params: Promise<{ batchId: string }> }) {
    const { batchId } = use(params);
    const router = useRouter();

    const [data, setData] = useState<BatchDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState('');
    const [searchCode, setSearchCode] = useState('');
    const [actionLoading, setActionLoading] = useState<string | null>(null);

    // Revoke modal state
    const [revokeModal, setRevokeModal] = useState<{ couponId: string; code: string } | null>(null);
    const [revokeReason, setRevokeReason] = useState('');
    const [revokeNotes, setRevokeNotes] = useState('');

    // Expire all modal
    const [showExpireModal, setShowExpireModal] = useState(false);

    const fetchBatch = async (page = 1) => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page), limit: '50' });
            if (statusFilter) params.set('status', statusFilter);
            if (searchCode) params.set('search', searchCode);

            const res = await fetch(`/api/admin/coupons/batches/${batchId}?${params}`);
            const json = await res.json();
            if (json.success) setData(json.data);
        } catch { /* silent */ }
        finally { setLoading(false); }
    };

    useEffect(() => { fetchBatch(); }, [batchId, statusFilter]);

    const handleDownload = () => {
        window.open(`/api/admin/coupons/batches/${batchId}/download`, '_blank');
    };

    const handleRelease = async (couponId: string) => {
        setActionLoading(couponId);
        try {
            const res = await fetch(`/api/admin/coupons/${couponId}/release`, { method: 'POST' });
            const json = await res.json();
            if (json.success) fetchBatch(data?.pagination.page);
        } catch { /* silent */ }
        finally { setActionLoading(null); }
    };

    const handleRevoke = async () => {
        if (!revokeModal || !revokeReason) return;
        setActionLoading(revokeModal.couponId);
        try {
            const res = await fetch(`/api/admin/coupons/${revokeModal.couponId}/revoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: revokeReason, notes: revokeNotes }),
            });
            const json = await res.json();
            if (json.success) {
                setRevokeModal(null);
                setRevokeReason('');
                setRevokeNotes('');
                fetchBatch(data?.pagination.page);
            }
        } catch { /* silent */ }
        finally { setActionLoading(null); }
    };

    const handleExpireAll = async () => {
        setActionLoading('expire-all');
        try {
            const res = await fetch(`/api/admin/coupons/batches/${batchId}/expire-all`, { method: 'POST' });
            const json = await res.json();
            if (json.success) {
                setShowExpireModal(false);
                fetchBatch();
            }
        } catch { /* silent */ }
        finally { setActionLoading(null); }
    };

    if (loading && !data) {
        return (
            <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
            </div>
        );
    }

    if (!data) {
        return (
            <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
                <p className="text-gray-500">Batch not found</p>
            </div>
        );
    }

    const { batch, stats, coupons, pagination } = data;

    return (
        <div className="min-h-screen bg-[#F8F9FA] p-6">
            <div className="max-w-7xl mx-auto space-y-6">
                {/* Header */}
                <div className="flex items-center gap-3">
                    <button onClick={() => router.push('/admin/coupon-management')} className="p-2 hover:bg-gray-100 rounded-lg transition">
                        <ArrowLeft className="w-5 h-5 text-gray-600" />
                    </button>
                    <div className="flex-1">
                        <h1 className="text-2xl font-bold text-gray-900">{batch.name}</h1>
                        <p className="text-sm text-gray-500 mt-0.5">
                            <span className="font-mono">{batch.id}</span> &middot; {batch.dealer_name || batch.dealer_id} &middot; Value: {Number(batch.coupon_value) === 0 ? 'Free' : `₹${batch.coupon_value}`}
                        </p>
                    </div>
                </div>

                {/* Stats Cards */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {[
                        { label: 'Available', count: stats.available || 0, color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
                        { label: 'Reserved', count: stats.reserved || 0, color: 'text-blue-600 bg-blue-50 border-blue-200' },
                        { label: 'Used', count: stats.used || 0, color: 'text-purple-600 bg-purple-50 border-purple-200' },
                        { label: 'Expired', count: stats.expired || 0, color: 'text-red-600 bg-red-50 border-red-200' },
                        { label: 'Revoked', count: stats.revoked || 0, color: 'text-gray-600 bg-gray-50 border-gray-200' },
                    ].map(s => (
                        <div key={s.label} className={`${s.color} border rounded-xl p-4 text-center`}>
                            <p className="text-2xl font-bold">{s.count}</p>
                            <p className="text-xs font-semibold mt-0.5">{s.label}</p>
                        </div>
                    ))}
                </div>

                {/* Actions Bar */}
                <div className="flex items-center gap-3 flex-wrap">
                    <button onClick={handleDownload} className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition flex items-center gap-2">
                        <Download className="w-4 h-4" />
                        Download Available
                    </button>
                    {batch.status === 'active' && (
                        <button onClick={() => setShowExpireModal(true)} className="px-4 py-2 bg-red-50 border border-red-200 rounded-xl text-sm font-medium text-red-700 hover:bg-red-100 transition flex items-center gap-2">
                            <XCircle className="w-4 h-4" />
                            Expire All
                        </button>
                    )}
                </div>

                {/* Filters */}
                <div className="flex items-center gap-3">
                    <div className="relative flex-1 max-w-xs">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search by code..."
                            value={searchCode}
                            onChange={e => setSearchCode(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && fetchBatch()}
                            className="w-full h-10 pl-10 pr-4 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-teal-500 transition"
                        />
                    </div>
                    <select
                        value={statusFilter}
                        onChange={e => setStatusFilter(e.target.value)}
                        className="h-10 px-4 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-teal-500 transition"
                    >
                        <option value="">All Status</option>
                        <option value="available">Available</option>
                        <option value="reserved">Reserved</option>
                        <option value="used">Used</option>
                        <option value="expired">Expired</option>
                        <option value="revoked">Revoked</option>
                    </select>
                </div>

                {/* Coupon Table */}
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-gray-100 bg-gray-50/50">
                                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Coupon Code</th>
                                    <th className="text-center px-4 py-3 font-semibold text-gray-600">Status</th>
                                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Reserved For</th>
                                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Used For</th>
                                    <th className="text-center px-4 py-3 font-semibold text-gray-600">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {coupons.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="px-4 py-10 text-center text-gray-400">
                                            <Package className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                            No coupons found
                                        </td>
                                    </tr>
                                ) : coupons.map(coupon => {
                                    const badge = STATUS_BADGE[coupon.status] || STATUS_BADGE.available;
                                    return (
                                        <tr key={coupon.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition">
                                            <td className="px-4 py-3 font-mono text-xs font-bold text-gray-800">{coupon.code}</td>
                                            <td className="px-4 py-3 text-center">
                                                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${badge.bg}`}>
                                                    {badge.icon}
                                                    {coupon.status}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-xs text-gray-500">
                                                {coupon.reserved_for_lead_id ? (
                                                    <span>
                                                        {coupon.reserved_for_lead_id}
                                                        {coupon.reserved_at && <span className="text-gray-400 ml-1">{new Date(coupon.reserved_at).toLocaleDateString('en-IN')}</span>}
                                                    </span>
                                                ) : '-'}
                                            </td>
                                            <td className="px-4 py-3 text-xs text-gray-500">
                                                {coupon.used_by_lead_id ? (
                                                    <span>
                                                        {coupon.used_by_lead_id}
                                                        {coupon.used_at && <span className="text-gray-400 ml-1">{new Date(coupon.used_at).toLocaleDateString('en-IN')}</span>}
                                                    </span>
                                                ) : '-'}
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                {coupon.status === 'reserved' && (
                                                    <button
                                                        onClick={() => handleRelease(coupon.id)}
                                                        disabled={actionLoading === coupon.id}
                                                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-xs font-bold hover:bg-blue-100 transition disabled:opacity-50"
                                                    >
                                                        {actionLoading === coupon.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unlock className="w-3 h-3" />}
                                                        Release
                                                    </button>
                                                )}
                                                {coupon.status === 'available' && (
                                                    <button
                                                        onClick={() => setRevokeModal({ couponId: coupon.id, code: coupon.code })}
                                                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-700 rounded-lg text-xs font-bold hover:bg-red-100 transition"
                                                    >
                                                        <Ban className="w-3 h-3" />
                                                        Revoke
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    {pagination.totalPages > 1 && (
                        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
                            <p className="text-xs text-gray-500">
                                Page {pagination.page}/{pagination.totalPages} ({pagination.total} coupons)
                            </p>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => fetchBatch(pagination.page - 1)}
                                    disabled={pagination.page <= 1}
                                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50 transition"
                                >
                                    Prev
                                </button>
                                <button
                                    onClick={() => fetchBatch(pagination.page + 1)}
                                    disabled={pagination.page >= pagination.totalPages}
                                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50 transition"
                                >
                                    Next
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Revoke Modal */}
            {revokeModal && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-2xl p-6 max-w-md w-full space-y-4">
                        <h3 className="text-lg font-bold text-gray-900">Revoke Coupon: <span className="font-mono">{revokeModal.code}</span></h3>

                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-2">Reason for Revocation *</label>
                            <div className="space-y-2">
                                {['Fraud suspected', 'Wrong batch allocation', 'Dealer suspended', 'Duplicate coupon', 'Other'].map(r => (
                                    <label key={r} className="flex items-center gap-2 text-sm cursor-pointer">
                                        <input
                                            type="radio"
                                            name="revoke-reason"
                                            value={r}
                                            checked={revokeReason === r}
                                            onChange={e => setRevokeReason(e.target.value)}
                                            className="accent-red-600"
                                        />
                                        {r}
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Additional Notes</label>
                            <textarea
                                value={revokeNotes}
                                onChange={e => setRevokeNotes(e.target.value)}
                                rows={3}
                                className="w-full px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm outline-none focus:border-red-400 transition resize-none"
                                placeholder="Optional details..."
                            />
                        </div>

                        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl">
                            <p className="text-xs text-red-700 font-medium flex items-center gap-1.5">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                This action is permanent and cannot be undone.
                            </p>
                        </div>

                        <div className="flex items-center justify-end gap-3 pt-2">
                            <button
                                onClick={() => { setRevokeModal(null); setRevokeReason(''); setRevokeNotes(''); }}
                                className="px-4 py-2 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleRevoke}
                                disabled={!revokeReason || actionLoading === revokeModal.couponId}
                                className="px-5 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700 transition disabled:opacity-50 flex items-center gap-2"
                            >
                                {actionLoading === revokeModal.couponId && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Confirm Revoke
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Expire All Modal */}
            {showExpireModal && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-2xl p-6 max-w-md w-full space-y-4">
                        <h3 className="text-lg font-bold text-gray-900">Expire Entire Batch?</h3>
                        <p className="text-sm text-gray-600">
                            This will expire all coupons in batch <span className="font-mono font-bold">{batch.id}</span> ({batch.name}).
                        </p>
                        <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                            <p className="font-semibold">Affected Coupons:</p>
                            <ul className="mt-1 space-y-0.5">
                                <li>Available: <span className="font-bold">{stats.available || 0}</span></li>
                                <li>Reserved: <span className="font-bold">{stats.reserved || 0}</span></li>
                            </ul>
                            <p className="mt-1 text-xs text-amber-600">Used and already-expired coupons are unaffected.</p>
                        </div>
                        <div className="flex items-center justify-end gap-3 pt-2">
                            <button
                                onClick={() => setShowExpireModal(false)}
                                className="px-4 py-2 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleExpireAll}
                                disabled={actionLoading === 'expire-all'}
                                className="px-5 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700 transition disabled:opacity-50 flex items-center gap-2"
                            >
                                {actionLoading === 'expire-all' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Expire All Available Coupons
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
