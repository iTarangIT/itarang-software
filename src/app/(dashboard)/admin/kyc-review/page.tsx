'use client';

import { useState, useEffect } from 'react';
import {
    Loader2, Search, CheckCircle2, XCircle, AlertTriangle,
    FileText, User, ChevronDown, ChevronRight, Eye, Download,
    MessageSquare, Clock, Shield, RefreshCw
} from 'lucide-react';
import { toast } from 'sonner';

type ReviewableDoc = {
    id: string;
    lead_id: string;
    document_type: string;
    document_url: string;
    status: string;
    uploaded_at: string;
    ocr_data: Record<string, unknown> | null;
    review_for: 'primary' | 'co_borrower';
};

type LeadReview = {
    lead_id: string;
    owner_name: string;
    dealer_name: string;
    kyc_status: string;
    interest_level: string;
    has_co_borrower: boolean;
    documents: ReviewableDoc[];
    review_count: number;
    pending_count: number;
};

export default function AdminKYCReviewPage() {
    const [leads, setLeads] = useState<LeadReview[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterStatus, setFilterStatus] = useState('pending');
    const [expandedLead, setExpandedLead] = useState<string | null>(null);
    const [reviewingDoc, setReviewingDoc] = useState<string | null>(null);
    const [reviewAction, setReviewAction] = useState<'verified' | 'rejected' | 'request_additional'>('verified');
    const [reviewNotes, setReviewNotes] = useState('');
    const [rejectionReason, setRejectionReason] = useState('');
    const [additionalDocRequest, setAdditionalDocRequest] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const fetchReviews = async (silent = false) => {
        try {
            if (!silent) setLoading(true);
            const params = new URLSearchParams({ status: filterStatus, search: searchQuery });
            const res = await fetch(`/api/admin/kyc-reviews?${params}`);
            const data = await res.json();
            if (data.success) setLeads(data.data);
        } catch { /* silent */ }
        finally { if (!silent) setLoading(false); }
    };

    useEffect(() => {
        fetchReviews();
    }, [filterStatus, searchQuery]);

    // Auto-refresh every 30 seconds
    useEffect(() => {
        const interval = setInterval(() => fetchReviews(true), 30000);
        return () => clearInterval(interval);
    }, [filterStatus, searchQuery]);

    const handleReviewSubmit = async (docId: string, leadId: string) => {
        setSubmitting(true);
        try {
            const res = await fetch('/api/admin/kyc-reviews', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    document_id: docId,
                    lead_id: leadId,
                    outcome: reviewAction,
                    reviewer_notes: reviewNotes,
                    rejection_reason: reviewAction === 'rejected' ? rejectionReason : null,
                    additional_doc_requested: reviewAction === 'request_additional' ? additionalDocRequest : null,
                }),
            });
            const data = await res.json();
            if (data.success) {
                toast.success(`Document ${reviewAction === 'verified' ? 'verified' : reviewAction === 'rejected' ? 'rejected' : 'additional docs requested'} successfully`);
                setReviewingDoc(null);
                setReviewNotes('');
                setRejectionReason('');
                setAdditionalDocRequest('');
                await fetchReviews(true);
            } else {
                toast.error(data.error?.message || 'Review action failed');
            }
        } catch { toast.error('Failed to submit review'); }
        finally { setSubmitting(false); }
    };

    const pendingLeads = leads.filter(l => l.pending_count > 0);
    const totalDocs = leads.reduce((sum, l) => sum + l.documents.length, 0);
    const totalPending = leads.reduce((sum, l) => sum + l.pending_count, 0);

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1400px] mx-auto px-6 py-8">
                <header className="mb-8">
                    <h1 className="text-[28px] font-black text-gray-900 tracking-tight">KYC Document Review</h1>
                    <p className="text-sm text-gray-500 mt-1">Review and validate KYC documents submitted by dealers for their leads</p>
                </header>

                {/* KPI Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                    <KPICard icon={<FileText className="w-5 h-5" />} label="Total Leads" value={leads.length.toString()} color="blue" />
                    <KPICard icon={<Clock className="w-5 h-5" />} label="Pending Review" value={totalPending.toString()} color="amber" />
                    <KPICard icon={<CheckCircle2 className="w-5 h-5" />} label="Total Documents" value={totalDocs.toString()} color="green" />
                    <KPICard icon={<AlertTriangle className="w-5 h-5" />} label="Leads Needing Action" value={pendingLeads.length.toString()} color="red" />
                </div>

                {/* Filters */}
                <div className="flex items-center gap-3 mb-6">
                    {['pending', 'all', 'verified', 'rejected'].map(s => (
                        <button key={s} onClick={() => setFilterStatus(s)} className={`px-4 py-2 rounded-xl text-sm font-bold capitalize ${filterStatus === s ? 'bg-[#0047AB] text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
                            {s === 'pending' ? 'Needs Review' : s}
                        </button>
                    ))}
                    <div className="flex-1" />
                    <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search lead or dealer..." className="pl-10 pr-4 py-2 border border-gray-200 rounded-xl text-sm w-64 outline-none focus:border-[#1D4ED8]" />
                    </div>
                </div>

                {/* Lead Review Cards */}
                <div className="space-y-4">
                    {loading ? (
                        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-[#1D4ED8]" /></div>
                    ) : leads.length === 0 ? (
                        <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm text-center py-20 text-gray-400">
                            <Shield className="w-12 h-12 mx-auto mb-3 opacity-30" />
                            <p className="font-bold">No documents to review</p>
                        </div>
                    ) : (
                        leads.map(lead => (
                            <div key={lead.lead_id} className="bg-white rounded-[20px] border border-gray-100 shadow-sm overflow-hidden">
                                {/* Lead Header */}
                                <button
                                    onClick={() => setExpandedLead(expandedLead === lead.lead_id ? null : lead.lead_id)}
                                    className="w-full flex items-center justify-between p-6 hover:bg-gray-50/50"
                                >
                                    <div className="flex items-center gap-4">
                                        <div className="w-11 h-11 rounded-xl bg-blue-50 flex items-center justify-center">
                                            <User className="w-5 h-5 text-blue-600" />
                                        </div>
                                        <div className="text-left">
                                            <div className="font-bold text-gray-900">{lead.owner_name}</div>
                                            <div className="text-xs text-gray-500">Lead: {lead.lead_id} · Dealer: {lead.dealer_name}</div>
                                        </div>
                                        {lead.has_co_borrower && (
                                            <span className="px-2 py-0.5 bg-purple-50 text-purple-700 text-[10px] font-bold rounded-full">Has Co-Borrower</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <div className="text-right">
                                            <div className="text-sm font-bold text-gray-900">{lead.documents.length} docs</div>
                                            <div className="text-xs text-gray-500">{lead.pending_count} pending</div>
                                        </div>
                                        <span className={`px-3 py-1 rounded-full text-[10px] font-bold capitalize ${lead.kyc_status === 'verified' ? 'bg-green-50 text-green-700' : lead.kyc_status === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                                            {lead.kyc_status || 'pending'}
                                        </span>
                                        <a
                                            href={`/admin/kyc-review/${lead.lead_id}`}
                                            onClick={(e) => e.stopPropagation()}
                                            className="px-3 py-1.5 bg-[#0047AB] text-white rounded-lg text-[10px] font-bold hover:bg-[#003580]"
                                        >
                                            Review
                                        </a>
                                        {expandedLead === lead.lead_id ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
                                    </div>
                                </button>

                                {/* Expanded: Document List */}
                                {expandedLead === lead.lead_id && (
                                    <div className="border-t border-gray-100 px-6 pb-6">
                                        <table className="w-full text-sm mt-4">
                                            <thead>
                                                <tr className="border-b border-gray-100">
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Document</th>
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Type</th>
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Uploaded</th>
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Status</th>
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {lead.documents.map(doc => {
                                                    const isSignedConsent = doc.document_type === 'signed_consent';
                                                    const displayLabel = isSignedConsent
                                                        ? 'Signed Consent (DigiO)'
                                                        : doc.document_type.replace(/_/g, ' ');
                                                    return (
                                                    <tr key={doc.id} className="border-b border-gray-50">
                                                        <td className="py-3 px-3">
                                                            <div className="font-medium capitalize">{displayLabel}</div>
                                                            <div className="text-[10px] text-gray-400">{doc.review_for === 'co_borrower' ? 'Co-Borrower' : 'Primary'}</div>
                                                        </td>
                                                        <td className="py-3 px-3 text-xs text-gray-500">{doc.review_for}</td>
                                                        <td className="py-3 px-3 text-xs text-gray-500">{doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : '—'}</td>
                                                        <td className="py-3 px-3">
                                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${doc.status === 'verified' ? 'bg-green-50 text-green-700' : doc.status === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                                                                {doc.status}
                                                            </span>
                                                        </td>
                                                        <td className="py-3 px-3">
                                                            <div className="flex items-center gap-2">
                                                                {doc.document_url && (
                                                                    <a href={doc.document_url} target="_blank" rel="noopener noreferrer" className="p-1.5 bg-gray-50 rounded-lg hover:bg-gray-100 text-gray-600">
                                                                        <Eye className="w-3.5 h-3.5" />
                                                                    </a>
                                                                )}
                                                                {isSignedConsent ? (
                                                                    doc.status !== 'verified' && (
                                                                        <a
                                                                            href={`/admin/kyc-review/${lead.lead_id}`}
                                                                            onClick={(e) => e.stopPropagation()}
                                                                            className="px-3 py-1 bg-[#0047AB] text-white rounded-lg text-[10px] font-bold hover:bg-[#003580]"
                                                                        >
                                                                            Review Consent
                                                                        </a>
                                                                    )
                                                                ) : (
                                                                    doc.status !== 'verified' && (
                                                                        <button onClick={() => { setReviewingDoc(doc.id); setReviewAction('verified'); }} className="px-3 py-1 bg-[#0047AB] text-white rounded-lg text-[10px] font-bold hover:bg-[#003580]">
                                                                            Review
                                                                        </button>
                                                                    )
                                                                )}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>

                                        {/* Review Modal Inline */}
                                        {reviewingDoc && lead.documents.find(d => d.id === reviewingDoc) && (
                                            <div className="mt-4 p-5 bg-gray-50 rounded-2xl border border-gray-200">
                                                <h4 className="font-bold text-gray-900 mb-4">Review Document: {lead.documents.find(d => d.id === reviewingDoc)?.document_type.replace(/_/g, ' ')}</h4>

                                                <div className="flex gap-2 mb-4">
                                                    {(['verified', 'rejected', 'request_additional'] as const).map(action => (
                                                        <button key={action} onClick={() => setReviewAction(action)} className={`px-4 py-2 rounded-xl text-xs font-bold capitalize ${reviewAction === action ? (action === 'verified' ? 'bg-green-600 text-white' : action === 'rejected' ? 'bg-red-600 text-white' : 'bg-amber-600 text-white') : 'bg-white border border-gray-200 text-gray-600'}`}>
                                                            {action === 'verified' && <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />}
                                                            {action === 'rejected' && <XCircle className="w-3.5 h-3.5 inline mr-1" />}
                                                            {action === 'request_additional' && <MessageSquare className="w-3.5 h-3.5 inline mr-1" />}
                                                            {action.replace(/_/g, ' ')}
                                                        </button>
                                                    ))}
                                                </div>

                                                {reviewAction === 'rejected' && (
                                                    <input value={rejectionReason} onChange={e => setRejectionReason(e.target.value)} placeholder="Rejection reason *" className="w-full mb-3 h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                                )}
                                                {reviewAction === 'request_additional' && (
                                                    <input value={additionalDocRequest} onChange={e => setAdditionalDocRequest(e.target.value)} placeholder="What additional document is needed? *" className="w-full mb-3 h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                                )}

                                                <textarea value={reviewNotes} onChange={e => setReviewNotes(e.target.value)} placeholder="Reviewer notes (optional)" className="w-full mb-4 min-h-[60px] px-4 py-3 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />

                                                <div className="flex gap-3">
                                                    <button onClick={() => setReviewingDoc(null)} className="px-5 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600">Cancel</button>
                                                    <button
                                                        onClick={() => handleReviewSubmit(reviewingDoc, lead.lead_id)}
                                                        disabled={submitting || (reviewAction === 'rejected' && !rejectionReason) || (reviewAction === 'request_additional' && !additionalDocRequest)}
                                                        className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2"
                                                    >
                                                        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                                        Submit Review
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

function KPICard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
    const colorClasses: Record<string, string> = { blue: 'bg-blue-50 text-blue-600', green: 'bg-green-50 text-green-600', amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600' };
    return (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${colorClasses[color]}`}>{icon}</div>
            <p className="text-2xl font-black text-gray-900">{value}</p>
            <p className="text-xs font-medium text-gray-400 mt-1">{label}</p>
        </div>
    );
}
