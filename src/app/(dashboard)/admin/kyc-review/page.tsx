'use client';

import { useState, useEffect } from 'react';
import {
    Loader2, Search, CheckCircle2, XCircle, AlertTriangle,
    FileText, User, ChevronDown, ChevronRight, Eye, Download,
    MessageSquare, Clock, Shield, RefreshCw
} from 'lucide-react';
import { toast } from 'sonner';

// E-282 — lender status inline on each lead card: which NBFC holds the file,
// what stage it is in, how long, and whose move it is. Fetched per visible
// lead from the file-tracker API and merged client-side; no separate tab.
import LeadNbfcUpdates, { LenderChip, type TrackerRow } from './_components/LeadNbfcUpdates';
import DeleteApplicationButton from '@/components/shared/DeleteApplicationButton';

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
    dealer_id?: string | null;
    city?: string | null;
    submitted_at?: string | null;
    reviewed_at?: string | null;
    kyc_status: string;
    interest_level: string;
    has_co_borrower: boolean;
    documents: ReviewableDoc[];
    review_count: number;
    pending_count: number;
    rejection_count?: number;
    latest_rejection_reason?: string | null;
    latest_rejection_document_type?: string | null;
    latest_rejected_at?: string | null;
};

type KycSummary = {
    queue: { pending: number; inProgress: number; requestedCorrection: number; rejected: number; approved: number };
    rejectedLeads: number;
    latestRejection: { lead_id: string; rejection_reason: string | null; document_type: string | null; reviewed_at: string | null } | null;
    loans: { sanctioned: number; disbursed: number };
};

// Lead ids per file-tracker request. Keeps the query string short and stays
// well under the route's 500-row JSON cap for any one call.
const NBFC_FETCH_CHUNK = 100;

export default function AdminKYCReviewPage() {
    const [leads, setLeads] = useState<LeadReview[]>([]);
    // leadId → one row per lender assignment (a lead can be with >1 NBFC).
    const [nbfcFiles, setNbfcFiles] = useState<Record<string, TrackerRow[]>>({});
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterStatus, setFilterStatus] = useState('pending');
    // B12 — lead-level filters. The list AND the export take exactly these,
    // so what downloads is what is on screen.
    const [filterDealer, setFilterDealer] = useState('');
    const [filterCity, setFilterCity] = useState('');
    const [filterFrom, setFilterFrom] = useState('');
    const [filterTo, setFilterTo] = useState('');
    const [dealerOptions, setDealerOptions] = useState<{ id: string; name: string }[]>([]);
    const leadFilterParams = () => {
        const p: Record<string, string> = {};
        if (filterDealer) p.dealer_id = filterDealer;
        if (filterCity.trim()) p.city = filterCity.trim();
        if (filterFrom) p.from = filterFrom;
        if (filterTo) p.to = filterTo;
        return p;
    };
    const anyLeadFilter = !!(filterDealer || filterCity.trim() || filterFrom || filterTo);
    const [expandedLead, setExpandedLead] = useState<string | null>(null);
    const [reviewingDoc, setReviewingDoc] = useState<string | null>(null);
    const [reviewAction, setReviewAction] = useState<'verified' | 'rejected' | 'request_additional'>('verified');
    const [reviewNotes, setReviewNotes] = useState('');
    const [rejectionReason, setRejectionReason] = useState('');
    const [additionalDocRequest, setAdditionalDocRequest] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [summary, setSummary] = useState<KycSummary | null>(null);

    // B12 — bulk KYC export, one button: with cases ticked it exports those;
    // with nothing ticked it exports every case currently listed (tab, dealer,
    // city, date and search filters all applied). Both paths go
    // through POST so a long id list never has to fit in a URL. The route is
    // admin / CEO / sales head only and logs every download to audit_logs.
    const [selectedLeads, setSelectedLeads] = useState<Set<string>>(() => new Set());
    const [exporting, setExporting] = useState<'all' | 'selected' | null>(null);
    const toggleLead = (id: string) =>
        setSelectedLeads(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    const exportKyc = async (mode: 'all' | 'selected') => {
        // Always the ids ON SCREEN. The tab filter here ("Rejected" = leads with
        // a rejected DOCUMENT) is not the export route's status filter ("rejected"
        // = case outcome), so re-deriving the set server-side can disagree with
        // the list. Sending the listed ids makes the file exactly the list.
        const body: Record<string, unknown> =
            mode === 'selected'
                ? { lead_ids: Array.from(selectedLeads) }
                : { lead_ids: leads.map(l => l.lead_id) };
        setExporting(mode);
        try {
            const res = await fetch('/api/admin/exports/kyc.xlsx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                let detail = '';
                try { const j = await res.json(); detail = j?.error?.message ?? j?.error ?? ''; } catch { detail = await res.text().catch(() => ''); }
                throw new Error(res.status === 403 ? 'Only admin, CEO or sales head can export KYC data.' : String(detail).slice(0, 200) || 'Export failed');
            }
            const rows = Number(res.headers.get('X-Export-Rows') ?? 0);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'kyc-export.xlsx';
            a.click();
            URL.revokeObjectURL(url);
            toast.success(`Exported ${rows} KYC row${rows === 1 ? '' : 's'}.`);
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setExporting(null);
        }
    };

    // Queue-status / rejection / sanction counts — server-side, independent of
    // the filter tabs (those only change which leads are listed below).
    const fetchSummary = async () => {
        try {
            const res = await fetch('/api/admin/kyc-reviews/summary', { cache: 'no-store' });
            const json = await res.json();
            if (res.ok && json.success) setSummary(json.data as KycSummary);
        } catch { /* silent */ }
    };

    // Lender status for the leads on screen. Failures are silent: the card
    // simply shows no lender chip until the next refresh.
    const fetchNbfcFiles = async (leadIds: string[]) => {
        if (leadIds.length === 0) { setNbfcFiles({}); return; }
        try {
            const chunks: string[][] = [];
            for (let i = 0; i < leadIds.length; i += NBFC_FETCH_CHUNK) {
                chunks.push(leadIds.slice(i, i + NBFC_FETCH_CHUNK));
            }
            const results = await Promise.all(chunks.map(async chunk => {
                const params = new URLSearchParams({ leadIds: chunk.join(',') });
                const res = await fetch(`/api/admin/nbfc-file-tracker?${params}`, { cache: 'no-store' });
                const json = await res.json();
                return res.ok && json.success ? (json.data.rows as TrackerRow[]) : [];
            }));
            const byLead: Record<string, TrackerRow[]> = {};
            for (const row of results.flat()) {
                (byLead[row.leadId] ??= []).push(row);
            }
            setNbfcFiles(byLead);
        } catch { /* silent */ }
    };

    const fetchReviews = async (silent = false) => {
        try {
            if (!silent) setLoading(true);
            const params = new URLSearchParams({ status: filterStatus, search: searchQuery, ...leadFilterParams() });
            const res = await fetch(`/api/admin/kyc-reviews?${params}`);
            const data = await res.json();
            if (data.success) {
                const list = data.data as LeadReview[];
                setLeads(list);
                void fetchNbfcFiles(list.map(l => l.lead_id));
            }
        } catch { /* silent */ }
        finally { if (!silent) setLoading(false); }
    };

    useEffect(() => {
        fetchReviews();
    }, [filterStatus, searchQuery, filterDealer, filterCity, filterFrom, filterTo]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/admin/dealers?limit=1000', { cache: 'no-store' });
                const j = await res.json();
                if (j?.success && Array.isArray(j.data)) {
                    setDealerOptions(
                        j.data
                            .map((d: { id: string; business_entity_name?: string | null }) => ({ id: d.id, name: d.business_entity_name || d.id }))
                            .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
                    );
                }
            } catch { /* dropdown stays empty; typing a city still works */ }
        })();
    }, []);

    useEffect(() => {
        fetchSummary();
        const interval = setInterval(fetchSummary, 30000);
        return () => clearInterval(interval);
    }, []);

    // Auto-refresh every 30 seconds
    useEffect(() => {
        const interval = setInterval(() => fetchReviews(true), 30000);
        return () => clearInterval(interval);
    }, [filterStatus, searchQuery, filterDealer, filterCity, filterFrom, filterTo]);

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
                void fetchSummary();
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

                {/* Summary strip — queue status counts, rejections, sanctions */}
                <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-8">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Verification queue &amp; loans</p>
                        {summary?.latestRejection?.rejection_reason && (
                            <p
                                className="text-xs text-red-600 truncate max-w-[50%]"
                                title={summary.latestRejection.rejection_reason}
                            >
                                Latest rejection: {summary.latestRejection.rejection_reason}
                            </p>
                        )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                        <SummaryStat label="Pending verification" value={summary?.queue.pending} tone="amber" />
                        <SummaryStat label="In progress" value={summary?.queue.inProgress} tone="blue" />
                        <SummaryStat label="Correction requested" value={summary?.queue.requestedCorrection} tone="amber" />
                        <SummaryStat label="Approved" value={summary?.queue.approved} tone="green" />
                        <SummaryStat label="Rejected (queue)" value={summary?.queue.rejected} tone="red" />
                        <SummaryStat label="Leads with rejected docs" value={summary?.rejectedLeads} tone="red" />
                        <SummaryStat label="Sanctioned" value={summary?.loans.sanctioned} tone="green" />
                        <SummaryStat label="Disbursed" value={summary?.loans.disbursed} tone="green" />
                    </div>
                </div>

                {/* Filters */}
                <div className="flex items-center gap-3 mb-6">
                    {['pending', 'all', 'verified', 'rejected'].map(s => (
                        <button key={s} onClick={() => setFilterStatus(s)} className={`px-4 py-2 rounded-xl text-sm font-bold capitalize ${filterStatus === s ? 'bg-[#0047AB] text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
                            {s === 'pending' ? 'Needs Review' : s}
                        </button>
                    ))}
                    <div className="flex-1" />
                    {/* ONE button: ticked cases when any are ticked, otherwise every
                        case matching the current filter. The label says which. */}
                    <button
                        type="button"
                        onClick={() => exportKyc(selectedLeads.size > 0 ? 'selected' : 'all')}
                        disabled={exporting !== null}
                        title={selectedLeads.size > 0
                            ? `Excel of the ${selectedLeads.size} ticked case${selectedLeads.size === 1 ? '' : 's'}`
                            : 'Excel of every case matching the current filter — tick cases to export only those'}
                        className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-bold rounded-xl hover:bg-gray-50 disabled:opacity-50"
                    >
                        {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                        {selectedLeads.size > 0 ? `Export selected (${selectedLeads.size})` : 'Export'}
                    </button>
                    <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search lead or dealer..." className="pl-10 pr-4 py-2 border border-gray-200 rounded-xl text-sm w-64 outline-none focus:border-[#1D4ED8]" />
                    </div>
                </div>

                {/* B12 — lead-level filters: dealer, city, case date range. */}
                <div className="flex flex-wrap items-end gap-3 mb-6 -mt-3">
                    <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Dealer</label>
                        <select value={filterDealer} onChange={e => setFilterDealer(e.target.value)} className="h-10 min-w-[200px] px-3 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:border-[#1D4ED8]">
                            <option value="">All dealers</option>
                            {dealerOptions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">City</label>
                        <input value={filterCity} onChange={e => setFilterCity(e.target.value)} placeholder="Any city" className="h-10 w-40 px-3 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Case date from</label>
                        <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} className="h-10 px-3 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Case date to</label>
                        <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} className="h-10 px-3 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                    </div>
                    {anyLeadFilter && (
                        <button type="button" onClick={() => { setFilterDealer(''); setFilterCity(''); setFilterFrom(''); setFilterTo(''); }} className="h-10 px-4 text-sm font-bold text-gray-600 border border-gray-200 rounded-xl bg-white hover:bg-gray-50">
                            Clear filters
                        </button>
                    )}
                    <p className="text-xs text-gray-500 pb-2">
                        Case date = when the case was reviewed, or submitted while it is still pending. The export follows these filters.
                    </p>
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
                                {/* Lead Header. The delete control is a SIBLING of the
                                    expander, not a child: a <button> cannot nest. */}
                                <div className="flex items-stretch">
                                <label className="flex items-center pl-5 pr-1 cursor-pointer" title="Select for export">
                                    <input
                                        type="checkbox"
                                        checked={selectedLeads.has(lead.lead_id)}
                                        onChange={() => toggleLead(lead.lead_id)}
                                        className="h-4 w-4 rounded border-gray-300 text-[#0047AB] focus:ring-[#1D4ED8]"
                                    />
                                </label>
                                <button
                                    onClick={() => setExpandedLead(expandedLead === lead.lead_id ? null : lead.lead_id)}
                                    className="flex-1 min-w-0 flex items-center justify-between p-6 hover:bg-gray-50/50"
                                >
                                    <div className="flex items-center gap-4">
                                        <div className="w-11 h-11 rounded-xl bg-blue-50 flex items-center justify-center">
                                            <User className="w-5 h-5 text-blue-600" />
                                        </div>
                                        <div className="text-left">
                                            <div className="font-bold text-gray-900">{lead.owner_name}</div>
                                            <div className="text-xs text-gray-500">Lead: {lead.lead_id} · Dealer: {lead.dealer_name}</div>
                                            {lead.latest_rejection_reason && (
                                                <div
                                                    className="text-xs text-red-600 mt-0.5 truncate max-w-[420px]"
                                                    title={lead.latest_rejection_reason}
                                                >
                                                    Rejected{lead.latest_rejection_document_type ? ` (${lead.latest_rejection_document_type.replace(/_/g, ' ')})` : ''}: {lead.latest_rejection_reason}
                                                    {(lead.rejection_count ?? 0) > 1 ? ` · ${lead.rejection_count} rejections` : ''}
                                                </div>
                                            )}
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
                                        {/* E-282 — one chip per lender holding this file. */}
                                        {(nbfcFiles[lead.lead_id] ?? []).length > 0 && (
                                            <div className="flex flex-col items-end gap-1">
                                                {nbfcFiles[lead.lead_id].map(row => (
                                                    <LenderChip key={row.assignmentId} row={row} />
                                                ))}
                                            </div>
                                        )}
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
                                {/* E-285 — clears the application from the ADMIN
                                    dashboards only; dealer and lender keep theirs. */}
                                <div className="flex items-center pr-4">
                                    <DeleteApplicationButton
                                        endpoint={`/api/admin/leads/${lead.lead_id}`}
                                        applicationLabel={lead.owner_name}
                                        applicationId={lead.lead_id}
                                        scopeLabel="the admin dashboard"
                                        otherPartiesLabel="the dealer and any lender holding the file"
                                        onDeleted={() => fetchReviews(true)}
                                    />
                                </div>
                                </div>

                                {/* Expanded: Document List */}
                                {expandedLead === lead.lead_id && (
                                    <div className="border-t border-gray-100 px-6 pb-6">
                                        {/* E-282 — lender stage / waiting-on / age + action history. */}
                                        <LeadNbfcUpdates leadId={lead.lead_id} rows={nbfcFiles[lead.lead_id] ?? []} />
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
                                                    const isVideoKyc = doc.document_type === 'video_kyc';
                                                    const isActiveVideoKyc = doc.document_type === 'active_video_kyc';
                                                    const displayLabel = isSignedConsent
                                                        ? 'Signed Consent (DigiO)'
                                                        : isActiveVideoKyc
                                                            ? 'Video KYC (Decentro · Active)'
                                                            : isVideoKyc
                                                                ? 'Video KYC (Decentro)'
                                                                : doc.document_type.replace(/_/g, ' ');
                                                    // signed_consent, video_kyc, and active_video_kyc are all
                                                    // reviewed on the per-lead case-review page (which renders
                                                    // playback / PDF / match table + Accept/Reject via
                                                    // dedicated cards). The inline Review modal below only
                                                    // handles uploaded docs.
                                                    const reviewOnCasePage = isSignedConsent || isVideoKyc || isActiveVideoKyc;
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
                                                                {reviewOnCasePage ? (
                                                                    doc.status !== 'verified' && (
                                                                        <a
                                                                            href={`/admin/kyc-review/${lead.lead_id}`}
                                                                            onClick={(e) => e.stopPropagation()}
                                                                            className="px-3 py-1 bg-[#0047AB] text-white rounded-lg text-[10px] font-bold hover:bg-[#003580]"
                                                                        >
                                                                            {isActiveVideoKyc || isVideoKyc ? 'Review Video' : 'Review Consent'}
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

function SummaryStat({ label, value, tone }: { label: string; value: number | undefined; tone: 'amber' | 'blue' | 'green' | 'red' }) {
    const toneClass: Record<string, string> = { amber: 'text-amber-600', blue: 'text-blue-600', green: 'text-green-600', red: 'text-red-600' };
    return (
        <div className="rounded-xl bg-gray-50 px-3 py-2">
            <p className={`text-lg font-black ${toneClass[tone]}`}>{value ?? '—'}</p>
            <p className="text-[11px] font-medium text-gray-500 leading-tight">{label}</p>
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
