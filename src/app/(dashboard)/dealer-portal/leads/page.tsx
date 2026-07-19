'use client';

import Link from 'next/link';
import { PlusCircle, Search, Filter, Loader2, Trash2, X, AlertTriangle, Pencil, Save } from 'lucide-react';
import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { isCashMethod, isFinanceMethod } from '@/components/dealer-portal/lead-wizard/constants';

function DealerLeadsContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [leads, setLeads] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('All');
    const [typeFilter, setTypeFilter] = useState('All');
    const [deleteTarget, setDeleteTarget] = useState<any>(null);
    const [deleting, setDeleting] = useState(false);
    const [editTarget, setEditTarget] = useState<any>(null);
    const [editForm, setEditForm] = useState({ interest_level: '', payment_method: '', full_name: '', phone: '' });
    const [saving, setSaving] = useState(false);

    const fetchLeads = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (search) params.append('search', search);
            if (statusFilter !== 'All') params.append('status', statusFilter);
            if (typeFilter !== 'All') params.append('type', typeFilter);

            const res = await fetch(`/api/dealer/leads?${params.toString()}`);
            const data = await res.json();
            if (data.success) {
                setLeads(data.data);
            }
        } catch (error) {
            console.error('Failed to fetch leads', error);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const res = await fetch(`/api/dealer/leads/${deleteTarget.id}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                setDeleteTarget(null);
                fetchLeads();
            } else {
                toast.error(data.error?.message || data.message || 'Failed to delete lead');
            }
        } catch {
            toast.error('Failed to delete lead');
        } finally {
            setDeleting(false);
        }
    };

    const openEdit = (lead: any) => {
        setEditTarget(lead);
        setEditForm({
            interest_level: lead.interest_level || '',
            payment_method: lead.payment_method || '',
            full_name: lead.full_name || lead.owner_name || '',
            phone: lead.phone || lead.owner_contact || '',
        });
    };

    const handleSaveEdit = async () => {
        if (!editTarget) return;
        setSaving(true);
        try {
            const res = await fetch(`/api/dealer/leads/${editTarget.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editForm),
            });
            const data = await res.json();
            if (data.success || (data.data && data.data.success)) {
                setEditTarget(null);
                fetchLeads();
            } else {
                const msg = data.error?.message || data.error || data.message || 'Failed to update lead';
                toast.error(msg);
            }
        } catch {
            toast.error('Failed to update lead');
        } finally {
            setSaving(false);
        }
    };

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => {
            fetchLeads();
        }, 500);
        return () => clearTimeout(timer);
    }, [search, statusFilter, typeFilter]);

    // Highlight new lead
    const newLeadId = searchParams.get('new');

    // Deep-link a lead to its CURRENT step (furthest reached). Shared by the
    // desktop table and the mobile card list so the routing logic lives once.
    const resolveLeadHref = (lead: any): string => {
        const isHot = lead.interest_level === 'hot';
        const cash = isCashMethod(lead.payment_method);
        const finance = isFinanceMethod(lead.payment_method);
        if (finance && lead.kyc_status === 'loan_sanctioned') return `/dealer-portal/leads/${lead.id}/step-5`;
        if (lead.has_product_selection) return `/dealer-portal/leads/${lead.id}/product-selection`;
        if (isHot && finance) return `/dealer-portal/leads/${lead.id}/kyc`;
        if (isHot && cash) return `/dealer-portal/leads/${lead.id}/product-selection`;
        return `/dealer-portal/leads/new?id=${lead.id}`;
    };

    // Prefer the product-selection FINAL PRICE; fall back to requested loan amount.
    const formatLeadAmount = (lead: any): string => {
        const amount = lead.final_price ?? lead.loan_amount;
        return amount ? `₹${Number(amount).toLocaleString()}` : '-';
    };

    // The pipeline advances `kyc_status` (loan_sanctioned → dispatched → sold),
    // while `lead_status` is frozen at 'new' the whole way through. So the badge
    // is derived from kyc_status first — once Step 5 dispatch is confirmed the
    // loan is disbursed and the unit dispatched, which we surface as "Disbursed".
    // Falls back to the raw lead_status for leads still in the sales funnel.
    const resolveLeadStatus = (lead: any): { label: string; cls: string } => {
        const kyc = String(lead.kyc_status || '').toLowerCase();
        if (kyc === 'dispatched' || kyc === 'sold') {
            return { label: 'Disbursed', cls: 'bg-green-100 text-green-800' };
        }
        if (kyc === 'loan_sanctioned') {
            return { label: 'Sanctioned', cls: 'bg-emerald-100 text-emerald-800' };
        }
        if (kyc === 'loan_rejected') {
            return { label: 'Rejected', cls: 'bg-red-100 text-red-800' };
        }
        const status = lead.lead_status || 'new';
        return {
            label: status,
            cls: status === 'new' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800',
        };
    };

    return (
        // -mx-6 cancels the dashboard layout's mobile p-6 so cards run
        // edge-to-edge on phones; the header keeps a small gutter via px-4 on
        // the title row. Reverts at sm+ (desktop/tablet unchanged).
        <div className="space-y-6 -mx-6 sm:mx-0">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 sm:px-0">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Lead Management</h1>
                    <p className="text-gray-500 text-sm">Track and manage your customer pipeline</p>
                </div>
                <Link href="/dealer-portal/leads/new" className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white font-medium rounded-lg hover:bg-brand-700 transition-colors shadow-sm">
                    <PlusCircle className="w-5 h-5" />
                    New Lead
                </Link>
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4 p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by name, phone..."
                        className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
                    />
                </div>
                <div className="flex gap-2">
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                        <option>All</option>
                        <option value="new">New</option>
                        <option value="contacted">Contacted</option>
                        <option value="qualified">Qualified</option>
                    </select>
                    <select
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                        className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                        <option>All</option>
                        <option value="hot">Hot</option>
                        <option value="warm">Warm</option>
                        <option value="cold">Cold</option>
                    </select>
                </div>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden min-h-[300px]">
                {loading ? (
                    <div className="flex items-center justify-center h-48">
                        <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
                    </div>
                ) : leads.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-gray-500">
                        <Filter className="w-8 h-8 mb-2 opacity-50" />
                        <p>No leads found matching your criteria</p>
                    </div>
                ) : (
                  <>
                    {/* Desktop table */}
                    <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50 border-b border-gray-200 text-xs uppercase text-gray-500 font-semibold tracking-wider">
                                    <th className="px-6 py-4">Customer</th>
                                    <th className="px-6 py-4">Status</th>
                                    <th className="px-6 py-4">Interest</th>
                                    <th className="px-6 py-4">Loan Amount</th>
                                    <th className="px-6 py-4">Created</th>
                                    <th className="px-6 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 text-sm">
                                {leads.map((lead: any) => (
                                    <tr key={lead.id} className={`hover:bg-gray-50 transition-colors group ${newLeadId === lead.id ? 'bg-brand-50' : ''}`}>
                                        <td className="px-6 py-4">
                                            <div className="font-medium text-gray-900">{lead.owner_name}</div>
                                            <div className="text-gray-500 text-xs">{lead.owner_contact}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            {(() => {
                                                const s = resolveLeadStatus(lead);
                                                return (
                                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${s.cls}`}>
                                                        {s.label}
                                                    </span>
                                                );
                                            })()}
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="inline-flex items-center gap-1.5 capitalize">
                                                <span className={`w-2 h-2 rounded-full 
                                                    ${lead.interest_level === 'hot' ? 'bg-red-500' : lead.interest_level === 'warm' ? 'bg-yellow-500' : 'bg-blue-500'}
                                                `}></span>
                                                {lead.interest_level}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-gray-600">
                                            {(() => {
                                                // Prefer the product-selection FINAL PRICE (battery + charger +
                                                // paraphernalia + dealer margin); fall back to the lead's
                                                // originally-requested loan amount before a selection exists.
                                                const amount = lead.final_price ?? lead.loan_amount;
                                                return amount ? `₹${Number(amount).toLocaleString()}` : '-';
                                            })()}
                                        </td>
                                        <td className="px-6 py-4 text-gray-500">
                                            {new Date(lead.created_at).toLocaleDateString()}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                {(() => {
                                                    const isHot = lead.interest_level === 'hot';
                                                    const cash = isCashMethod(lead.payment_method);
                                                    const finance = isFinanceMethod(lead.payment_method);
                                                    // Deep-link to the lead's CURRENT step (furthest reached),
                                                    // not a fixed one, so "View Details" resumes where it left off.
                                                    let href: string;
                                                    if (finance && lead.kyc_status === 'loan_sanctioned') {
                                                        // Sanctioned finance → Step 5 (dispatch / OTP).
                                                        href = `/dealer-portal/leads/${lead.id}/step-5`;
                                                    } else if (lead.has_product_selection) {
                                                        // A product selection exists → resume at Product Selection.
                                                        href = `/dealer-portal/leads/${lead.id}/product-selection`;
                                                    } else if (isHot && finance) {
                                                        href = `/dealer-portal/leads/${lead.id}/kyc`;
                                                    } else if (isHot && cash) {
                                                        href = `/dealer-portal/leads/${lead.id}/product-selection`;
                                                    } else {
                                                        // Cold / Warm leads stay at Step 1 — open the wizard with
                                                        // ?id=… so the dealer can edit fields like address.
                                                        href = `/dealer-portal/leads/new?id=${lead.id}`;
                                                    }
                                                    return (
                                                        <Link
                                                            href={href}
                                                            className="text-brand-600 hover:text-brand-800 font-medium text-xs"
                                                            title="Open this lead at its current step"
                                                        >
                                                            View Details
                                                        </Link>
                                                    );
                                                })()}
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); openEdit(lead); }}
                                                    className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                                                    title="Edit lead"
                                                >
                                                    <Pencil className="w-3.5 h-3.5" />
                                                </button>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(lead); }}
                                                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                                                    title="Delete lead"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Mobile cards — same data, stacked & readable on phones. */}
                    <div className="md:hidden divide-y divide-gray-100">
                        {leads.map((lead: any) => (
                            <div key={lead.id} className={`p-4 ${newLeadId === lead.id ? 'bg-brand-50' : ''}`}>
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="font-medium text-gray-900 truncate">{lead.owner_name}</div>
                                        <div className="text-gray-500 text-xs">{lead.owner_contact}</div>
                                    </div>
                                    {(() => {
                                        const s = resolveLeadStatus(lead);
                                        return (
                                            <span className={`shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${s.cls}`}>
                                                {s.label}
                                            </span>
                                        );
                                    })()}
                                </div>
                                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                                    <div>
                                        <p className="text-[11px] uppercase tracking-wide text-gray-400">Interest</p>
                                        <span className="inline-flex items-center gap-1.5 capitalize text-gray-700">
                                            <span className={`w-2 h-2 rounded-full
                                                ${lead.interest_level === 'hot' ? 'bg-red-500' : lead.interest_level === 'warm' ? 'bg-yellow-500' : 'bg-blue-500'}`}></span>
                                            {lead.interest_level}
                                        </span>
                                    </div>
                                    <div>
                                        <p className="text-[11px] uppercase tracking-wide text-gray-400">Loan Amount</p>
                                        <p className="text-gray-700">{formatLeadAmount(lead)}</p>
                                    </div>
                                    <div>
                                        <p className="text-[11px] uppercase tracking-wide text-gray-400">Created</p>
                                        <p className="text-gray-600">{new Date(lead.created_at).toLocaleDateString()}</p>
                                    </div>
                                </div>
                                <div className="mt-4 flex items-center gap-2">
                                    <Link
                                        href={resolveLeadHref(lead)}
                                        className="flex-1 text-center px-3 py-2 bg-brand-50 text-brand-700 rounded-lg text-sm font-semibold hover:bg-brand-100 transition-colors"
                                    >
                                        View Details
                                    </Link>
                                    <button
                                        onClick={() => openEdit(lead)}
                                        className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                                        title="Edit lead"
                                        aria-label="Edit lead"
                                    >
                                        <Pencil className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => setDeleteTarget(lead)}
                                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                                        title="Delete lead"
                                        aria-label="Delete lead"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                  </>
                )}
            </div>

            {/* Edit Lead Modal */}
            {editTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden">
                        <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-5">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                                        <Pencil className="w-5 h-5 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-white">Edit Lead</h3>
                                        <p className="text-blue-100 text-xs mt-0.5">{editTarget.id}</p>
                                    </div>
                                </div>
                                <button onClick={() => setEditTarget(null)} className="text-white/70 hover:text-white">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                        <div className="px-6 py-5 space-y-4">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Full Name</label>
                                <input
                                    type="text"
                                    value={editForm.full_name}
                                    onChange={e => setEditForm(prev => ({ ...prev, full_name: e.target.value }))}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Phone</label>
                                <input
                                    type="text"
                                    value={editForm.phone}
                                    onChange={e => setEditForm(prev => ({ ...prev, phone: e.target.value }))}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">Interest Level</label>
                                    <select
                                        value={editForm.interest_level}
                                        onChange={e => setEditForm(prev => ({ ...prev, interest_level: e.target.value }))}
                                        className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                    >
                                        <option value="">Select</option>
                                        <option value="hot">Hot</option>
                                        <option value="warm">Warm</option>
                                        <option value="cold">Cold</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">Payment Method</label>
                                    <select
                                        value={editForm.payment_method}
                                        onChange={e => setEditForm(prev => ({ ...prev, payment_method: e.target.value }))}
                                        className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                    >
                                        <option value="">Select</option>
                                        <option value="cash">Cash</option>
                                        <option value="dealer_finance">Dealer Finance</option>
                                        <option value="other_finance">Other Finance</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div className="px-6 pb-5 flex gap-3">
                            <button onClick={() => setEditTarget(null)} disabled={saving}
                                className="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl font-semibold text-sm text-gray-600 hover:bg-gray-50 transition-all">
                                Cancel
                            </button>
                            <button onClick={handleSaveEdit} disabled={saving}
                                className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                {saving ? 'Saving...' : 'Save Changes'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {deleteTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
                        <div className="bg-gradient-to-r from-red-500 to-red-600 px-6 py-5">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                                    <AlertTriangle className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-white">Delete Lead</h3>
                                    <p className="text-red-100 text-xs mt-0.5">This action cannot be undone</p>
                                </div>
                            </div>
                        </div>
                        <div className="px-6 py-5 space-y-4">
                            <div className="bg-red-50 border border-red-100 rounded-xl p-4">
                                <p className="text-sm text-gray-700">
                                    Are you sure you want to permanently delete this lead?
                                </p>
                                <div className="mt-3 space-y-1.5">
                                    <div className="flex justify-between text-sm">
                                        <span className="text-gray-500">Customer</span>
                                        <span className="font-semibold text-gray-900">{deleteTarget.owner_name || deleteTarget.full_name || 'Unknown'}</span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-gray-500">Lead ID</span>
                                        <span className="font-semibold text-gray-900">{deleteTarget.id}</span>
                                    </div>
                                </div>
                            </div>
                            <p className="text-xs text-gray-500">
                                All associated data including KYC documents, verifications, and consent records will be permanently removed.
                            </p>
                        </div>
                        <div className="px-6 pb-5 flex gap-3">
                            <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                                className="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl font-semibold text-sm text-gray-600 hover:bg-gray-50 transition-all">
                                Cancel
                            </button>
                            <button onClick={handleDelete} disabled={deleting}
                                className="flex-1 px-4 py-3 bg-red-600 text-white rounded-xl font-semibold text-sm hover:bg-red-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                {deleting ? 'Deleting...' : 'Delete Lead'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function DealerLeadsPage() {
    return (
        <Suspense fallback={
            <div className="flex flex-col items-center justify-center p-8 h-96">
                <Loader2 className="w-8 h-8 text-brand-600 animate-spin mb-4" />
                <p className="text-gray-500">Loading leads...</p>
            </div>
        }>
            <DealerLeadsContent />
        </Suspense>
    );
}
