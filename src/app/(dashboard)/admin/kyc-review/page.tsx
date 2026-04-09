'use client';

import { useState, useEffect } from 'react';
import {
    Loader2, Search, CheckCircle2, XCircle, AlertTriangle,
    FileText, User, ChevronDown, ChevronRight, Eye, Download,
    MessageSquare, Clock, Shield, Send, ThumbsUp, ThumbsDown,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

type ReviewableDoc = {
    id: string;
    lead_id: string;
    doc_type: string;
    file_url: string | null;
    file_name: string | null;
    doc_status: string;
    verification_status: string;
    rejection_reason: string | null;
    uploaded_at: string;
    ocr_data: Record<string, unknown> | null;
};

type LeadReview = {
    lead_id: string;
    customer_name: string;
    dealer_name: string;
    kyc_status: string;
    interest_level: string;
    documents: ReviewableDoc[];
    total_docs: number;
    pending_count: number;
};

type ConsentReview = {
    id: string;
    lead_id: string;
    consent_for: string;
    consent_type: string | null;
    consent_status: string;
    signed_consent_url: string | null;
    generated_pdf_url: string | null;
    sign_method: string | null;
    signed_at: string | null;
    created_at: string;
    updated_at: string;
    lead: {
        id: string;
        full_name: string | null;
        owner_name: string | null;
        phone: string | null;
        dealer_id: string | null;
    } | null;
};

// ── Main Page ────────────────────────────────────────────────────────────────

export default function AdminKYCReviewPage() {
    const [activeTab, setActiveTab] = useState<'documents' | 'consent'>('documents');
    const [leads, setLeads] = useState<LeadReview[]>([]);
    const [consents, setConsents] = useState<ConsentReview[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterStatus, setFilterStatus] = useState('pending');

    // Document review state
    const [expandedLead, setExpandedLead] = useState<string | null>(null);
    const [reviewingDoc, setReviewingDoc] = useState<string | null>(null);
    const [reviewAction, setReviewAction] = useState<'verified' | 'rejected' | 'request_additional'>('verified');
    const [reviewNotes, setReviewNotes] = useState('');
    const [rejectionReason, setRejectionReason] = useState('');
    const [additionalDocRequest, setAdditionalDocRequest] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Consent review state
    const [reviewingConsent, setReviewingConsent] = useState<string | null>(null);
    const [consentDecision, setConsentDecision] = useState<'approved' | 'rejected'>('approved');
    const [consentNotes, setConsentNotes] = useState('');
    const [consentRejectionReason, setConsentRejectionReason] = useState('');

    // ── Data Fetching ────────────────────────────────────────────────────────

    const fetchData = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ status: filterStatus, search: searchQuery, tab: activeTab });
            const res = await fetch(`/api/admin/kyc-reviews?${params}`);
            const data = await res.json();
            if (data.success) {
                if (activeTab === 'consent') setConsents(data.data);
                else setLeads(data.data);
            }
        } catch { /* silent */ }
        finally { setLoading(false); }
    };

    useEffect(() => { fetchData(); }, [filterStatus, searchQuery, activeTab]);

    // ── Document Review Handler ──────────────────────────────────────────────

    const handleDocReviewSubmit = async (docId: string, leadId: string) => {
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
                setReviewingDoc(null);
                setReviewNotes('');
                setRejectionReason('');
                setAdditionalDocRequest('');
                await fetchData();
            }
        } catch { /* silent */ }
        finally { setSubmitting(false); }
    };

    // ── Consent Review Handler ───────────────────────────────────────────────

    const handleConsentReviewSubmit = async (consent: ConsentReview) => {
        setSubmitting(true);
        try {
            const res = await fetch(`/api/kyc/${consent.lead_id}/consent/admin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    decision: consentDecision,
                    reviewerNotes: consentNotes,
                    rejectionReason: consentDecision === 'rejected' ? consentRejectionReason : null,
                }),
            });
            const data = await res.json();
            if (data.success) {
                setReviewingConsent(null);
                setConsentNotes('');
                setConsentRejectionReason('');
                await fetchData();
            }
        } catch { /* silent */ }
        finally { setSubmitting(false); }
    };

    // ── Stats ────────────────────────────────────────────────────────────────

    const totalDocs = leads.reduce((sum, l) => sum + l.total_docs, 0);
    const totalPending = leads.reduce((sum, l) => sum + l.pending_count, 0);
    const pendingConsents = consents.filter(c => ['admin_review_pending', 'consent_uploaded', 'esign_completed'].includes(c.consent_status)).length;

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1400px] mx-auto px-6 py-8">
                <header className="mb-8">
                    <h1 className="text-[28px] font-black text-gray-900 tracking-tight">KYC Review Queue</h1>
                    <p className="text-sm text-gray-500 mt-1">Review documents and consent forms submitted by dealers</p>
                </header>

                {/* KPI Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                    <KPICard icon={<FileText className="w-5 h-5" />} label="Total Leads" value={leads.length.toString()} color="blue" />
                    <KPICard icon={<Clock className="w-5 h-5" />} label="Docs Pending" value={totalPending.toString()} color="amber" />
                    <KPICard icon={<Shield className="w-5 h-5" />} label="Consents Pending" value={pendingConsents.toString()} color="purple" />
                    <KPICard icon={<CheckCircle2 className="w-5 h-5" />} label="Total Documents" value={totalDocs.toString()} color="green" />
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1 w-fit mb-6">
                    <button onClick={() => setActiveTab('documents')}
                        className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'documents' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                        Documents {totalPending > 0 && <span className="ml-1 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[10px] font-bold">{totalPending}</span>}
                    </button>
                    <button onClick={() => setActiveTab('consent')}
                        className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'consent' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                        Consent {pendingConsents > 0 && <span className="ml-1 px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-full text-[10px] font-bold">{pendingConsents}</span>}
                    </button>
                </div>

                {/* Filters */}
                <div className="flex items-center gap-3 mb-6">
                    {['pending', 'all', 'verified', 'rejected'].map(s => (
                        <button key={s} onClick={() => setFilterStatus(s)} className={`px-4 py-2 rounded-xl text-sm font-bold capitalize ${filterStatus === s ? 'bg-[#0047AB] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-[#0047AB]'}`}>
                            {s === 'pending' ? 'Needs Review' : s}
                        </button>
                    ))}
                    <div className="flex-1" />
                    <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search lead or dealer..." className="pl-10 pr-4 py-2 border border-gray-200 rounded-xl text-sm w-64 outline-none focus:border-[#1D4ED8]" />
                    </div>
                </div>

                {/* Content */}
                {loading ? (
                    <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-[#1D4ED8]" /></div>
                ) : activeTab === 'documents' ? (
                    /* ── Documents Tab ──────────────────────────────────────── */
                    <div className="space-y-4">
                        {leads.length === 0 ? (
                            <EmptyState message="No documents to review" />
                        ) : leads.map(lead => (
                            <div key={lead.lead_id} className="bg-white rounded-[20px] border border-gray-100 shadow-sm overflow-hidden">
                                <button onClick={() => setExpandedLead(expandedLead === lead.lead_id ? null : lead.lead_id)}
                                    className="w-full flex items-center justify-between p-6 hover:bg-gray-50/50">
                                    <div className="flex items-center gap-4">
                                        <div className="w-11 h-11 rounded-xl bg-blue-50 flex items-center justify-center">
                                            <User className="w-5 h-5 text-blue-600" />
                                        </div>
                                        <div className="text-left">
                                            <div className="font-bold text-gray-900">{lead.customer_name}</div>
                                            <div className="text-xs text-gray-500">Lead: {lead.lead_id} · Dealer: {lead.dealer_name}</div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <div className="text-right">
                                            <div className="text-sm font-bold text-gray-900">{lead.total_docs} docs</div>
                                            {lead.pending_count > 0 && <div className="text-xs text-amber-600 font-medium">{lead.pending_count} pending</div>}
                                        </div>
                                        {expandedLead === lead.lead_id ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
                                    </div>
                                </button>

                                {expandedLead === lead.lead_id && (
                                    <div className="border-t border-gray-100 px-6 pb-6">
                                        <table className="w-full text-sm mt-4">
                                            <thead>
                                                <tr className="border-b border-gray-100">
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Document</th>
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Uploaded</th>
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Status</th>
                                                    <th className="text-left py-3 px-3 font-bold text-gray-500 text-xs uppercase">Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {lead.documents.map(doc => (
                                                    <tr key={doc.id} className="border-b border-gray-50">
                                                        <td className="py-3 px-3 font-medium capitalize">{doc.doc_type.replace(/_/g, ' ')}</td>
                                                        <td className="py-3 px-3 text-xs text-gray-500">{doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : '-'}</td>
                                                        <td className="py-3 px-3">
                                                            <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold capitalize ${
                                                                doc.doc_status === 'verified' ? 'bg-green-50 text-green-700' :
                                                                doc.doc_status === 'rejected' || doc.doc_status === 'reupload_requested' ? 'bg-red-50 text-red-700' :
                                                                'bg-amber-50 text-amber-700'
                                                            }`}>{doc.doc_status?.replace(/_/g, ' ') || 'uploaded'}</span>
                                                        </td>
                                                        <td className="py-3 px-3">
                                                            <div className="flex items-center gap-2">
                                                                {doc.file_url && (
                                                                    <a href={doc.file_url} target="_blank" rel="noopener noreferrer"
                                                                        className="p-1.5 bg-gray-50 rounded-lg hover:bg-gray-100 text-gray-600" title="View">
                                                                        <Eye className="w-3.5 h-3.5" />
                                                                    </a>
                                                                )}
                                                                {doc.doc_status !== 'verified' && (
                                                                    <button onClick={() => { setReviewingDoc(doc.id); setReviewAction('verified'); }}
                                                                        className="px-3 py-1 bg-[#0047AB] text-white rounded-lg text-[10px] font-bold hover:bg-[#003580]">
                                                                        Review
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>

                                        {/* Inline Review Form */}
                                        {reviewingDoc && lead.documents.find(d => d.id === reviewingDoc) && (
                                            <div className="mt-4 p-5 bg-gray-50 rounded-2xl border border-gray-200">
                                                <h4 className="font-bold text-gray-900 mb-4">
                                                    Review: {lead.documents.find(d => d.id === reviewingDoc)?.doc_type.replace(/_/g, ' ')}
                                                </h4>
                                                <div className="flex gap-2 mb-4">
                                                    {(['verified', 'rejected', 'request_additional'] as const).map(action => (
                                                        <button key={action} onClick={() => setReviewAction(action)}
                                                            className={`px-4 py-2 rounded-xl text-xs font-bold capitalize ${
                                                                reviewAction === action
                                                                    ? action === 'verified' ? 'bg-green-600 text-white' : action === 'rejected' ? 'bg-red-600 text-white' : 'bg-amber-600 text-white'
                                                                    : 'bg-white border border-gray-200 text-gray-600'
                                                            }`}>
                                                            {action.replace(/_/g, ' ')}
                                                        </button>
                                                    ))}
                                                </div>
                                                {reviewAction === 'rejected' && (
                                                    <select value={rejectionReason} onChange={e => setRejectionReason(e.target.value)}
                                                        className="w-full mb-3 h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]">
                                                        <option value="">Select rejection reason *</option>
                                                        <option value="Document not legible">Document not legible</option>
                                                        <option value="Name mismatch">Name mismatch with lead</option>
                                                        <option value="Expired document">Expired document</option>
                                                        <option value="Wrong document type">Wrong document type</option>
                                                        <option value="Suspected forgery">Suspected forgery</option>
                                                        <option value="Incomplete document">Incomplete/cropped document</option>
                                                        <option value="Other">Other</option>
                                                    </select>
                                                )}
                                                {reviewAction === 'request_additional' && (
                                                    <input value={additionalDocRequest} onChange={e => setAdditionalDocRequest(e.target.value)}
                                                        placeholder="What document is needed? *"
                                                        className="w-full mb-3 h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                                )}
                                                <textarea value={reviewNotes} onChange={e => setReviewNotes(e.target.value)}
                                                    placeholder="Notes (optional)" rows={2}
                                                    className="w-full mb-4 px-4 py-3 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none resize-none focus:border-[#1D4ED8]" />
                                                <div className="flex gap-3">
                                                    <button onClick={() => setReviewingDoc(null)}
                                                        className="px-5 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
                                                    <button onClick={() => handleDocReviewSubmit(reviewingDoc, lead.lead_id)}
                                                        disabled={submitting || (reviewAction === 'rejected' && !rejectionReason) || (reviewAction === 'request_additional' && !additionalDocRequest)}
                                                        className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2 hover:bg-[#003580]">
                                                        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                                                        Submit Review
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    /* ── Consent Tab ────────────────────────────────────────── */
                    <div className="space-y-4">
                        {consents.length === 0 ? (
                            <EmptyState message="No consent forms to review" />
                        ) : consents.map(consent => (
                            <div key={consent.id} className="bg-white rounded-[20px] border border-gray-100 shadow-sm overflow-hidden">
                                <div className="p-6">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${
                                                consent.consent_type === 'digital' ? 'bg-blue-50' : 'bg-teal-50'
                                            }`}>
                                                {consent.consent_type === 'digital'
                                                    ? <Send className="w-5 h-5 text-blue-600" />
                                                    : <FileText className="w-5 h-5 text-teal-600" />}
                                            </div>
                                            <div>
                                                <div className="font-bold text-gray-900">{consent.lead?.full_name || consent.lead?.owner_name || 'Unknown'}</div>
                                                <div className="text-xs text-gray-500">
                                                    Lead: {consent.lead_id} · Type: {consent.consent_type || 'N/A'} · {consent.sign_method === 'aadhaar_esign' ? 'Aadhaar eSign' : 'Manual PDF'}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className={`px-3 py-1 rounded-full text-[10px] font-bold ${
                                                consent.consent_status === 'admin_verified' || consent.consent_status === 'manual_verified' ? 'bg-green-50 text-green-700' :
                                                consent.consent_status === 'admin_rejected' ? 'bg-red-50 text-red-700' :
                                                'bg-amber-50 text-amber-700'
                                            }`}>{consent.consent_status.replace(/_/g, ' ')}</span>

                                            {consent.signed_consent_url && (
                                                <a href={consent.signed_consent_url} target="_blank" rel="noopener noreferrer"
                                                    className="p-2 bg-gray-50 rounded-lg hover:bg-gray-100 text-gray-600" title="View PDF">
                                                    <Eye className="w-4 h-4" />
                                                </a>
                                            )}
                                            {consent.generated_pdf_url && !consent.signed_consent_url && (
                                                <a href={consent.generated_pdf_url} target="_blank" rel="noopener noreferrer"
                                                    className="p-2 bg-gray-50 rounded-lg hover:bg-gray-100 text-gray-600" title="View Generated PDF">
                                                    <Download className="w-4 h-4" />
                                                </a>
                                            )}

                                            {!['admin_verified', 'manual_verified', 'admin_rejected'].includes(consent.consent_status) && (
                                                <button onClick={() => { setReviewingConsent(consent.id); setConsentDecision('approved'); }}
                                                    className="px-4 py-2 bg-[#0047AB] text-white rounded-xl text-xs font-bold hover:bg-[#003580]">
                                                    Review
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Consent details */}
                                    <div className="mt-3 flex items-center gap-6 text-xs text-gray-500">
                                        {consent.signed_at && <span>Signed: {new Date(consent.signed_at).toLocaleString()}</span>}
                                        {consent.lead?.phone && <span>Phone: {consent.lead.phone}</span>}
                                        <span>Created: {new Date(consent.created_at).toLocaleDateString()}</span>
                                    </div>

                                    {/* Inline Review Form */}
                                    {reviewingConsent === consent.id && (
                                        <div className="mt-4 p-5 bg-gray-50 rounded-2xl border border-gray-200">
                                            <h4 className="font-bold text-gray-900 mb-4">Review Consent — {consent.lead?.full_name || consent.lead_id}</h4>

                                            {/* Admin Checklist for Manual Consent */}
                                            {consent.consent_type === 'manual' && (
                                                <div className="mb-4 p-4 bg-white border border-gray-200 rounded-xl">
                                                    <p className="text-xs font-bold text-gray-700 mb-2">Verification Checklist:</p>
                                                    <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                                                        {[
                                                            'PDF is legible and clear',
                                                            'All signature boxes filled',
                                                            'Thumb impression present',
                                                            'Witness signature present',
                                                            'Customer name matches lead',
                                                            'Date signed within 7 days',
                                                        ].map((item, i) => (
                                                            <label key={i} className="flex items-center gap-2 cursor-pointer">
                                                                <input type="checkbox" className="w-3.5 h-3.5 rounded border-gray-300 text-[#0047AB] focus:ring-[#0047AB]" />
                                                                <span>{item}</span>
                                                            </label>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            <div className="flex gap-2 mb-4">
                                                <button onClick={() => setConsentDecision('approved')}
                                                    className={`flex-1 px-4 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 ${
                                                        consentDecision === 'approved' ? 'bg-green-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
                                                    }`}>
                                                    <ThumbsUp className="w-3.5 h-3.5" /> Approve & Verify
                                                </button>
                                                <button onClick={() => setConsentDecision('rejected')}
                                                    className={`flex-1 px-4 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 ${
                                                        consentDecision === 'rejected' ? 'bg-red-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
                                                    }`}>
                                                    <ThumbsDown className="w-3.5 h-3.5" /> Reject
                                                </button>
                                            </div>

                                            {consentDecision === 'rejected' && (
                                                <select value={consentRejectionReason} onChange={e => setConsentRejectionReason(e.target.value)}
                                                    className="w-full mb-3 h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]">
                                                    <option value="">Select rejection reason *</option>
                                                    <option value="Signature mismatch">Signature mismatch</option>
                                                    <option value="Name mismatch with Aadhaar">Name mismatch with Aadhaar</option>
                                                    <option value="Incomplete consent text">Incomplete consent text</option>
                                                    <option value="Expired certificate">Expired certificate</option>
                                                    <option value="Fraudulent document suspected">Fraudulent document suspected</option>
                                                    <option value="PDF not legible">PDF not legible</option>
                                                    <option value="Thumb impression missing">Thumb impression missing</option>
                                                    <option value="Witness signature missing">Witness signature missing</option>
                                                    <option value="Other">Other</option>
                                                </select>
                                            )}

                                            <textarea value={consentNotes} onChange={e => setConsentNotes(e.target.value)}
                                                placeholder="Admin notes (optional)" rows={2}
                                                className="w-full mb-4 px-4 py-3 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none resize-none focus:border-[#1D4ED8]" />

                                            <div className="flex gap-3">
                                                <button onClick={() => setReviewingConsent(null)}
                                                    className="px-5 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
                                                <button onClick={() => handleConsentReviewSubmit(consent)}
                                                    disabled={submitting || (consentDecision === 'rejected' && !consentRejectionReason)}
                                                    className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2 hover:bg-[#003580]">
                                                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                                                    {consentDecision === 'approved' ? 'Approve Consent' : 'Reject Consent'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Shared Components ────────────────────────────────────────────────────────

function KPICard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
    const colorClasses: Record<string, string> = {
        blue: 'bg-blue-50 text-blue-600',
        green: 'bg-green-50 text-green-600',
        amber: 'bg-amber-50 text-amber-600',
        red: 'bg-red-50 text-red-600',
        purple: 'bg-purple-50 text-purple-600',
    };
    return (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${colorClasses[color] || colorClasses.blue}`}>{icon}</div>
            <p className="text-2xl font-black text-gray-900">{value}</p>
            <p className="text-xs font-medium text-gray-400 mt-1">{label}</p>
        </div>
    );
}

function EmptyState({ message }: { message: string }) {
    return (
        <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm text-center py-20 text-gray-400">
            <Shield className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-bold">{message}</p>
        </div>
    );
}
