'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    ChevronLeft, Loader2, User, Phone, MapPin, Calendar,
    CreditCard, FileCheck, Shield, Pencil, ChevronRight, AlertCircle, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

export default function LeadDetailPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;

    const [loading, setLoading] = useState(true);
    const [lead, setLead] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    // Editing state
    const [editing, setEditing] = useState(false);
    const [editForm, setEditForm] = useState<any>({});
    const [saving, setSaving] = useState(false);

    // Delete state
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        const fetchLead = async () => {
            try {
                // Use the access-check endpoint which returns full lead data
                const res = await fetch(`/api/kyc/${leadId}/access-check`, { cache: 'no-store' });
                const data = await res.json();

                if (!data.success && !data.lead) {
                    setError('Lead not found');
                    return;
                }

                setLead(data.lead);
                setEditForm({
                    full_name: data.lead?.full_name || data.lead?.owner_name || '',
                    phone: data.lead?.phone || data.lead?.owner_contact || '',
                    interest_level: data.lead?.interest_level || 'warm',
                    payment_method: data.lead?.payment_method || 'cash',
                });
            } catch {
                setError('Failed to load lead details');
            } finally {
                setLoading(false);
            }
        };
        fetchLead();
    }, [leadId]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/leads/${leadId}/update`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editForm),
            });
            const data = await res.json();
            if (data.success) {
                toast.success('Lead updated successfully');
                setLead((prev: any) => ({ ...prev, ...editForm }));
                setEditing(false);
            } else {
                toast.error(data.error?.message || 'Failed to update lead');
            }
        } catch {
            toast.error('Failed to update lead');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        try {
            const res = await fetch(`/api/dealer/leads/${leadId}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                toast.success('Lead deleted successfully');
                router.push('/dealer-portal/leads');
            } else {
                toast.error(data.error?.message || 'Failed to delete lead');
            }
        } catch {
            toast.error('Failed to delete lead');
        } finally {
            setDeleting(false);
            setShowDeleteConfirm(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
                <Loader2 className="w-10 h-10 animate-spin text-[#1D4ED8]" />
            </div>
        );
    }

    if (error || !lead) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
                <div className="text-center max-w-md">
                    <AlertCircle className="w-14 h-14 text-red-400 mx-auto mb-4" />
                    <h2 className="text-2xl font-bold text-gray-900">Lead Not Found</h2>
                    <p className="mt-2 text-sm text-gray-500">{error || 'This lead could not be found.'}</p>
                    <button onClick={() => router.push('/dealer-portal/leads')} className="mt-6 px-6 py-3 bg-[#0047AB] text-white rounded-xl font-bold">
                        Back to Leads
                    </button>
                </div>
            </div>
        );
    }

    const isFinance = ['other_finance', 'itarang_finance', 'bnpl'].includes(lead.payment_method || '');
    const displayName = lead.full_name || lead.owner_name || 'Unknown';
    const displayPhone = lead.phone || lead.owner_contact || '-';

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6 space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                                <Trash2 className="w-6 h-6 text-red-600" />
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-gray-900">Delete Lead?</h3>
                                <p className="text-sm text-gray-500 mt-0.5">This will permanently delete this lead and all associated KYC documents, consent records, and verifications.</p>
                            </div>
                        </div>
                        <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                            <p className="text-sm font-medium text-red-700">
                                {displayName} — {displayPhone}
                            </p>
                            <p className="text-xs text-red-600 mt-1">This action cannot be undone.</p>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setShowDeleteConfirm(false)}
                                disabled={deleting}
                                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDelete}
                                disabled={deleting}
                                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-xl font-medium hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                {deleting ? 'Deleting...' : 'Delete Lead'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="max-w-[1000px] mx-auto px-6 py-8">
                {/* Header */}
                <header className="mb-8 flex items-start justify-between">
                    <div className="flex gap-4">
                        <button onClick={() => router.push('/dealer-portal/leads')} className="mt-1 p-2 hover:bg-white transition-colors rounded-lg">
                            <ChevronLeft className="w-6 h-6 text-gray-900" />
                        </button>
                        <div>
                            <h1 className="text-[28px] font-black text-gray-900 leading-tight tracking-tight">Lead Details</h1>
                            <p className="text-sm text-gray-500 mt-0.5">Reference: {lead.reference_id || leadId}</p>
                        </div>
                    </div>
                    {!editing && (
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setEditing(true)}
                                className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-bold hover:border-[#0047AB] transition-all"
                            >
                                <Pencil className="w-4 h-4" /> Edit Lead
                            </button>
                            <button
                                onClick={() => setShowDeleteConfirm(true)}
                                className="flex items-center gap-2 px-4 py-2 bg-white border border-red-200 rounded-xl text-sm font-bold text-red-600 hover:bg-red-50 hover:border-red-400 transition-all"
                            >
                                <Trash2 className="w-4 h-4" /> Delete
                            </button>
                        </div>
                    )}
                </header>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Lead Info Card */}
                    <div className="lg:col-span-2 bg-white rounded-[24px] border border-[#E9ECEF] shadow-sm">
                        <div className="flex items-center gap-4 px-8 pt-8 pb-4">
                            <div className="w-[3px] h-6 bg-[#0047AB] rounded-full" />
                            <h3 className="text-lg font-black text-gray-900 tracking-tight">Customer Information</h3>
                        </div>
                        <div className="p-8 pt-4">
                            {editing ? (
                                <div className="space-y-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div>
                                            <label className="text-sm font-bold text-gray-700 mb-1 block">Full Name</label>
                                            <input
                                                value={editForm.full_name}
                                                onChange={e => setEditForm((p: any) => ({ ...p, full_name: e.target.value }))}
                                                className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm focus:border-[#1D4ED8] outline-none"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-sm font-bold text-gray-700 mb-1 block">Phone</label>
                                            <input
                                                value={editForm.phone}
                                                onChange={e => setEditForm((p: any) => ({ ...p, phone: e.target.value }))}
                                                className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm focus:border-[#1D4ED8] outline-none"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-sm font-bold text-gray-700 mb-1 block">Interest Level</label>
                                            <select
                                                value={editForm.interest_level}
                                                onChange={e => setEditForm((p: any) => ({ ...p, interest_level: e.target.value }))}
                                                className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm focus:border-[#1D4ED8] outline-none"
                                            >
                                                <option value="hot">Hot</option>
                                                <option value="warm">Warm</option>
                                                <option value="cold">Cold</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-sm font-bold text-gray-700 mb-1 block">Payment Method</label>
                                            <select
                                                value={editForm.payment_method}
                                                onChange={e => setEditForm((p: any) => ({ ...p, payment_method: e.target.value }))}
                                                className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm focus:border-[#1D4ED8] outline-none"
                                            >
                                                <option value="cash">Cash</option>
                                                <option value="upfront">Upfront</option>
                                                <option value="other_finance">Other Finance</option>
                                                <option value="itarang_finance">iTarang Finance</option>
                                                <option value="bnpl">BNPL</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div className="flex gap-3 pt-2">
                                        <button onClick={() => setEditing(false)} className="px-6 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50">
                                            Cancel
                                        </button>
                                        <button onClick={handleSave} disabled={saving} className="px-6 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] disabled:opacity-50 flex items-center gap-2">
                                            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                                            Save Changes
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                    <InfoRow icon={<User className="w-4 h-4" />} label="Full Name" value={displayName} />
                                    <InfoRow icon={<Phone className="w-4 h-4" />} label="Phone" value={displayPhone} />
                                    <InfoRow icon={<CreditCard className="w-4 h-4" />} label="Payment Method" value={(lead.payment_method || '-').replace(/_/g, ' ')} />
                                    <InfoRow
                                        icon={<div className={`w-3 h-3 rounded-full ${lead.interest_level === 'hot' ? 'bg-red-500' : lead.interest_level === 'warm' ? 'bg-amber-500' : 'bg-blue-500'}`} />}
                                        label="Interest Level"
                                        value={lead.interest_level || '-'}
                                    />
                                    <InfoRow icon={<FileCheck className="w-4 h-4" />} label="Lead Status" value={lead.lead_status || '-'} />
                                    <InfoRow icon={<Shield className="w-4 h-4" />} label="KYC Status" value={lead.kyc_status || 'Not started'} />
                                    {lead.asset_model && (
                                        <InfoRow icon={<Calendar className="w-4 h-4" />} label="Product" value={lead.asset_model} />
                                    )}
                                    {lead.consent_status && (
                                        <InfoRow icon={<FileCheck className="w-4 h-4" />} label="Consent Status" value={lead.consent_status.replace(/_/g, ' ')} />
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Actions Card */}
                    <div className="bg-white rounded-[24px] border border-[#E9ECEF] shadow-sm">
                        <div className="flex items-center gap-4 px-8 pt-8 pb-4">
                            <div className="w-[3px] h-6 bg-[#0047AB] rounded-full" />
                            <h3 className="text-lg font-black text-gray-900 tracking-tight">Actions</h3>
                        </div>
                        <div className="p-8 pt-4 space-y-3">
                            {isFinance ? (
                                <button
                                    onClick={() => router.push(`/dealer-portal/leads/${leadId}/kyc`)}
                                    className="w-full flex items-center justify-between px-5 py-4 bg-gradient-to-r from-[#0047AB] to-[#1D4ED8] text-white rounded-xl font-bold text-sm hover:from-[#003580] hover:to-[#1E40AF] transition-all shadow-lg shadow-blue-500/20"
                                >
                                    <div className="flex items-center gap-3">
                                        <Shield className="w-5 h-5" />
                                        <div className="text-left">
                                            <p>Proceed to KYC</p>
                                            <p className="text-xs font-normal text-blue-100 mt-0.5">Upload documents & consent</p>
                                        </div>
                                    </div>
                                    <ChevronRight className="w-5 h-5" />
                                </button>
                            ) : (
                                <div className="px-5 py-4 bg-gray-50 border border-gray-200 rounded-xl">
                                    <p className="text-sm font-semibold text-gray-700">KYC Not Required</p>
                                    <p className="text-xs text-gray-500 mt-1">This lead uses {(lead.payment_method || 'cash').replace(/_/g, ' ')} payment. KYC verification is not needed.</p>
                                </div>
                            )}

                            {lead.has_co_borrower && (
                                <button
                                    onClick={() => router.push(`/dealer-portal/leads/${leadId}/kyc/interim`)}
                                    className="w-full flex items-center justify-between px-5 py-4 bg-white border-2 border-[#0047AB] text-[#0047AB] rounded-xl font-bold text-sm hover:bg-blue-50 transition-all"
                                >
                                    <div className="flex items-center gap-3">
                                        <User className="w-5 h-5" />
                                        <div className="text-left">
                                            <p>Co-Borrower KYC</p>
                                            <p className="text-xs font-normal text-gray-500 mt-0.5">Upload co-borrower documents</p>
                                        </div>
                                    </div>
                                    <ChevronRight className="w-5 h-5" />
                                </button>
                            )}

                            <button
                                onClick={() => router.push('/dealer-portal/leads')}
                                className="w-full px-5 py-3 border border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50 transition-all"
                            >
                                Back to Lead List
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
    return (
        <div className="flex items-start gap-3">
            <div className="mt-0.5 text-gray-400">{icon}</div>
            <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
                <p className="text-sm font-semibold text-gray-900 capitalize mt-0.5">{value}</p>
            </div>
        </div>
    );
}
