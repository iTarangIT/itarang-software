'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
    AlertCircle, CheckCircle2, ChevronRight, Clock, Download, Eye,
    FileText, Loader2, Phone, RefreshCw, Scan, Send, Shield, Upload, X,
} from 'lucide-react';
import {
    SectionCard, InputField, SelectField, DocumentCard, StatusBadge, ProgressHeader,
    StickyBottomBar, ErrorBanner, PrimaryButton, SecondaryButton,
    OutlineButton, FullPageLoader, OCRModal,
} from '@/components/dealer-portal/lead-wizard/shared';
import { FINANCE_DOCUMENTS } from '@/components/dealer-portal/lead-wizard/constants';

// ─── Types ─────────────────────────────────────────────────────────────────

type UploadedDoc = {
    id?: string;
    doc_type: string;
    file_url: string | null;
    file_name?: string | null;
    file_size?: number | null;
    uploaded_at?: string | null;
    doc_status?: string;
    verification_status?: string;
    rejection_reason?: string | null;
    failed_reason?: string | null;
};

type RequestedDoc = {
    id: string;
    doc_label: string;
    doc_key: string;
    doc_for?: string;
    is_required: boolean;
    file_url: string | null;
    upload_status: 'not_uploaded' | 'uploaded' | 'rejected' | 'verified' | string;
    rejection_reason: string | null;
    uploaded_at: string | null;
    created_at: string;
};

type Step3Context = {
    lead_kyc_status: string;
    requires_supporting_docs: boolean;
    requires_co_borrower: boolean;
    is_replacement: boolean;
    latest_co_borrower_request: {
        id: string;
        attempt_number: number;
        reason: string | null;
        status: string;
        created_at: string;
    } | null;
    supporting_docs_summary: {
        total: number;
        required: number;
        uploaded: number;
        verified: number;
        rejected: number;
    };
};

// ─── Preview Customer Profile (read-only side-by-side modal) ───────────────
function maskAadhaar(value?: string | null): string {
    if (!value) return '—';
    const digits = String(value).replace(/\D/g, '');
    if (digits.length < 4) return digits;
    return `XXXX XXXX ${digits.slice(-4)}`;
}

function fmtDob(value?: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function PreviewProfileModal({
    open, onClose, lead, borrowerForm, includeCoBorrower,
}: {
    open: boolean;
    onClose: () => void;
    lead: any;
    borrowerForm: any;
    includeCoBorrower: boolean;
}) {
    if (!open) return null;
    const Field = ({ label, value }: { label: string; value: any }) => (
        <div className="py-2 border-b border-gray-100 last:border-b-0">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">{label}</p>
            <p className="text-sm font-medium text-gray-900 mt-0.5 break-words">{value || '—'}</p>
        </div>
    );

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-gray-900">Customer Profile (read-only)</h3>
                        <p className="text-xs text-gray-500 mt-0.5">Snapshot of primary applicant{includeCoBorrower ? ' and co-borrower' : ''}.</p>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg" aria-label="Close">
                        <X className="w-5 h-5 text-gray-400" />
                    </button>
                </div>

                <div className={`grid ${includeCoBorrower ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'} gap-0 overflow-y-auto`}>
                    {/* Primary applicant */}
                    <div className="p-6 border-r border-gray-100">
                        <p className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-3">Primary Applicant</p>
                        <Field label="Name" value={lead?.full_name || lead?.owner_name} />
                        <Field label="Phone" value={lead?.phone || lead?.owner_contact} />
                        <Field label="Date of Birth" value={fmtDob(lead?.dob)} />
                        <Field label="Aadhaar" value={maskAadhaar(lead?.aadhaar_no)} />
                        <Field label="PAN" value={lead?.pan_no} />
                        <Field label="Permanent Address" value={lead?.permanent_address} />
                        <Field label="Current Address" value={lead?.current_address || lead?.local_address} />
                    </div>

                    {/* Co-borrower */}
                    {includeCoBorrower ? (
                        <div className="p-6">
                            <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-3">Co-Borrower</p>
                            <Field label="Name" value={borrowerForm?.full_name} />
                            <Field label="Father / Husband" value={borrowerForm?.father_or_husband_name} />
                            <Field label="Phone" value={borrowerForm?.phone} />
                            <Field label="Date of Birth" value={fmtDob(borrowerForm?.dob)} />
                            <Field label="Aadhaar" value={maskAadhaar(borrowerForm?.aadhaar_no)} />
                            <Field label="PAN" value={borrowerForm?.pan_no} />
                            <Field label="Relationship" value={borrowerForm?.relationship ? borrowerForm.relationship.charAt(0).toUpperCase() + borrowerForm.relationship.slice(1) : '—'} />
                            <Field label="Permanent Address" value={borrowerForm?.permanent_address} />
                            <Field label="Current Address" value={borrowerForm?.current_address} />
                        </div>
                    ) : null}
                </div>

                <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-5 py-2 bg-[#0047AB] text-white rounded-lg text-sm font-bold hover:bg-[#003580]"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Other-Documentation Card (admin-requested supporting docs) ─────────────
function RequestedDocCard({
    doc, uploading, onUpload,
}: {
    doc: RequestedDoc;
    uploading: boolean;
    onUpload: (file: File) => void;
}) {
    const status = doc.upload_status;
    const statusBadge =
        status === 'verified' ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-[11px] font-bold">
                <CheckCircle2 className="w-3 h-3" /> Verified
            </span>
        ) : status === 'rejected' ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-red-100 text-red-700 rounded-full text-[11px] font-bold">
                <AlertCircle className="w-3 h-3" /> Rejected
            </span>
        ) : status === 'uploaded' ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[11px] font-bold">
                <Clock className="w-3 h-3" /> Pending Review
            </span>
        ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-gray-100 text-gray-600 rounded-full text-[11px] font-bold">
                Not Uploaded
            </span>
        );

    const borderClass =
        status === 'verified' ? 'border-emerald-200 bg-emerald-50/40'
        : status === 'rejected' ? 'border-red-200 bg-red-50/40'
        : status === 'uploaded' ? 'border-amber-200 bg-amber-50/40'
        : 'border-gray-200 bg-white';

    const canUpload = !uploading && status !== 'verified';
    const buttonLabel =
        status === 'rejected' ? 'Re-upload'
        : status === 'uploaded' ? 'Replace'
        : 'Upload';

    return (
        <div className={`rounded-2xl border-2 ${borderClass} p-4 transition-all`}>
            <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                    <h4 className="text-sm font-bold text-gray-900 truncate">
                        {doc.doc_label}
                        {doc.is_required && <span className="text-red-500 ml-1">*</span>}
                    </h4>
                    {!doc.is_required && (
                        <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Optional</span>
                    )}
                </div>
                {statusBadge}
            </div>

            {doc.rejection_reason && (
                <div className={`mb-2 text-xs ${status === 'rejected' ? 'text-red-700 bg-red-50 border border-red-200' : 'text-gray-600 bg-gray-50 border border-gray-100'} rounded-lg px-3 py-2`}>
                    <span className="font-bold">{status === 'rejected' ? 'Rejection reason: ' : 'Admin reason: '}</span>
                    <span className="italic">{doc.rejection_reason}</span>
                </div>
            )}

            {doc.uploaded_at && (
                <p className="text-[11px] text-gray-500 mb-2">
                    Uploaded: {new Date(doc.uploaded_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </p>
            )}

            <div className="flex items-center gap-2 mt-3">
                {doc.file_url && (
                    <a
                        href={doc.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[11px] font-bold text-gray-700 hover:bg-gray-50"
                    >
                        <Eye className="w-3 h-3" /> View
                    </a>
                )}
                {canUpload && (
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0047AB] text-white rounded-lg text-[11px] font-bold hover:bg-[#003580] cursor-pointer">
                        {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                        {uploading ? 'Uploading...' : buttonLabel}
                        <input
                            type="file"
                            className="hidden"
                            accept="image/png,image/jpeg,image/jpg,application/pdf"
                            onChange={e => e.target.files?.[0] && onUpload(e.target.files[0])}
                        />
                    </label>
                )}
            </div>
        </div>
    );
}

// ─── Consent Helpers ───────────────────────────────────────────────────────

function isFinalConsentStatus(status: string) {
    return ['admin_verified', 'manual_verified', 'verified'].includes((status || '').toLowerCase());
}

function ConsentStatusBadge({ status }: { status: string }) {
    const s = (status || '').toLowerCase();
    if (isFinalConsentStatus(s))
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Verified</span>;
    if (s === 'admin_review_pending')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold"><Clock className="w-3 h-3" />Pending Review</span>;
    if (s === 'admin_rejected')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold"><AlertCircle className="w-3 h-3" />Rejected</span>;
    if (s === 'esign_failed')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold"><AlertCircle className="w-3 h-3" />eSign Failed</span>;
    if (s === 'esign_blocked')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold"><AlertCircle className="w-3 h-3" />Blocked</span>;
    if (s === 'expired')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold"><Clock className="w-3 h-3" />Expired</span>;
    if (s === 'esign_completed')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Co-borrower Signed</span>;
    if (s === 'esign_in_progress')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Loader2 className="w-3 h-3 animate-spin" />Signing in Progress</span>;
    if (s === 'link_sent' || s === 'link_opened')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Send className="w-3 h-3" />{s === 'link_opened' ? 'Link Opened' : 'Link Sent'}</span>;
    if (s === 'consent_generated')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-teal-100 text-teal-700 rounded-full text-xs font-bold"><FileText className="w-3 h-3" />PDF Generated</span>;
    if (s === 'consent_uploaded')
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Upload className="w-3 h-3" />Uploaded</span>;
    return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-bold">Awaiting Signature</span>;
}

// ─── Main Page ─────────────────────────────────────────────────────────────

export default function BorrowerConsentPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;

    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [lead, setLead] = useState<any>(null);
    const [accessDenied, setAccessDenied] = useState(false);
    const [apiError, setApiError] = useState<string | null>(null);

    // Borrower form (editable)
    const [borrowerForm, setBorrowerForm] = useState({
        full_name: '', father_or_husband_name: '', dob: '', phone: '',
        email: '', pan_no: '', aadhaar_no: '',
        current_address: '', permanent_address: '', is_current_same: false,
        marital_status: '', income: '', relationship: '',
    });
    const [borrowerErrors, setBorrowerErrors] = useState<Record<string, string>>({});

    // Documents & Verifications
    const [uploadedDocs, setUploadedDocs] = useState<Record<string, UploadedDoc>>({});
    const [verifications, setVerifications] = useState<{ type: string; label: string; status: string; last_update?: string | null; failed_reason?: string | null }[]>([
        { type: 'aadhaar', label: 'Adhaar Verification', status: 'pending' },
        { type: 'pan', label: 'Pan verification', status: 'pending' },
        { type: 'bank', label: 'Bank Verification', status: 'pending' },
        { type: 'address_proof', label: 'Address Proof', status: 'pending' },
        { type: 'rc', label: 'RC Verification', status: 'pending' },
        { type: 'mobile', label: 'Mobile Number', status: 'pending' },
    ]);

    // Consent
    const [consentStatus, setConsentStatus] = useState<string>('awaiting_signature');
    const [consentPath, setConsentPath] = useState<'none' | 'digital' | 'manual'>('none');
    const [consentLoading, setConsentLoading] = useState(false);
    const [consentPdfUrl, setConsentPdfUrl] = useState<string | null>(null);
    const [consentRecord, setConsentRecord] = useState<any>(null);

    // Draft / navigation
    const [savingDraft, setSavingDraft] = useState(false);
    const [lastSaved, setLastSaved] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Aadhaar OCR autofill
    const [showOCR, setShowOCR] = useState(false);

    // Admin-requested supporting documents
    const [requestedDocs, setRequestedDocs] = useState<RequestedDoc[]>([]);
    const [requestedUploading, setRequestedUploading] = useState<Record<string, boolean>>({});

    // Step 3 context (gating, banner data) — fetched from /step3-context endpoint
    const [step3Ctx, setStep3Ctx] = useState<Step3Context | null>(null);

    // Preview Customer Profile modal
    const [showPreview, setShowPreview] = useState(false);

    // Co-borrower coupon state (separate from any primary-applicant coupon)
    const [cbCouponCode, setCbCouponCode] = useState('');
    const [cbCouponValidating, setCbCouponValidating] = useState(false);
    const [cbCouponResult, setCbCouponResult] = useState<{ success?: boolean; valid?: boolean; coupon_code?: string; status?: string; message?: string; already_used?: boolean } | null>(null);
    const [cbReleasingCoupon, setCbReleasingCoupon] = useState(false);

    // ─── Data Loading ──────────────────────────────────────────────────────

    const loadPageData = async (soft = false) => {
        if (soft) setRefreshing(true);
        else setLoading(true);

        try {
            setApiError(null);

            const accessRes = await fetch(`/api/kyc/${leadId}/access-check`, { cache: 'no-store' });
            const accessJson = await accessRes.json();

            const canAccess = accessJson?.data?.canAccess ?? accessJson?.allowed ?? false;
            const fetchedLead = accessJson?.data?.lead ?? accessJson?.lead ?? null;

            if (!canAccess) { setAccessDenied(true); setLead(fetchedLead); return; }

            if (!fetchedLead) {
                setAccessDenied(true);
                setApiError('Lead record could not be loaded. Please return to lead creation and try again.');
                return;
            }

            setAccessDenied(false);
            setLead(fetchedLead);
            if (fetchedLead?.borrower_consent_status) setConsentStatus(fetchedLead.borrower_consent_status);

            // Restore co-borrower coupon state if a coupon is already attached to the lead
            if (fetchedLead?.coupon_code && (fetchedLead.coupon_status === 'reserved' || fetchedLead.coupon_status === 'used')) {
                setCbCouponCode(fetchedLead.coupon_code);
                setCbCouponResult({ valid: true, success: true, coupon_code: fetchedLead.coupon_code, status: fetchedLead.coupon_status, message: `Coupon ${fetchedLead.coupon_status}` });
            }

            // Borrower is treated as independent from the customer. We do NOT
            // prefill the borrower form from lead (customer) fields — only
            // borrower-specific details persisted under this lead should
            // populate the form.

            const [personalRes, docsRes, verificationsRes, consentRes, requestedRes, ctxRes] = await Promise.allSettled([
                fetch(`/api/kyc/${leadId}/borrower-details`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/documents?doc_for=borrower`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/verifications?verification_for=borrower`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/consent/status?consent_for=borrower`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/requested-docs?doc_for=primary`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/step3-context`, { cache: 'no-store' }),
            ]);

            // Populate borrower form only from saved borrower-specific details.
            if (!soft && personalRes.status === 'fulfilled') {
                const personalJson = await personalRes.value.json();
                if (personalJson?.success && personalJson.data) {
                    const pd = personalJson.data;
                    setBorrowerForm(prev => ({
                        ...prev,
                        full_name: pd.full_name || pd.borrower_name || '',
                        phone: pd.phone || pd.borrower_phone || '',
                        permanent_address: pd.permanent_address || '',
                        aadhaar_no: pd.aadhaar_no || '',
                        pan_no: pd.pan_no || '',
                        email: pd.email || '',
                        income: pd.income || '',
                        marital_status: pd.marital_status || '',
                        father_or_husband_name: pd.father_husband_name || '',
                        current_address: pd.local_address || '',
                        dob: pd.dob ? new Date(pd.dob).toISOString().split('T')[0] : '',
                        relationship: pd.relationship || '',
                    }));
                }
            }

            if (docsRes.status === 'fulfilled') {
                const docsJson = await docsRes.value.json();
                if (docsJson?.success && Array.isArray(docsJson.data)) {
                    const mapped: Record<string, UploadedDoc> = {};
                    for (const doc of docsJson.data) mapped[doc.doc_type] = doc;
                    setUploadedDocs(mapped);
                }
            }

            if (consentRes.status === 'fulfilled') {
                const consentJson = await consentRes.value.json();
                if (consentJson?.success && consentJson.data) {
                    setConsentRecord(consentJson.data);
                    if (consentJson.data.consent_status) setConsentStatus(consentJson.data.consent_status);
                }
            }

            if (verificationsRes.status === 'fulfilled') {
                const verJson = await verificationsRes.value.json();
                if (verJson?.success && Array.isArray(verJson.data) && verJson.data.length > 0) {
                    setVerifications(verJson.data);
                }
            }

            if (requestedRes.status === 'fulfilled') {
                const reqJson = await requestedRes.value.json();
                if (reqJson?.success && Array.isArray(reqJson.data)) {
                    const sorted = [...reqJson.data].sort((a: RequestedDoc, b: RequestedDoc) => {
                        if (a.is_required !== b.is_required) return a.is_required ? -1 : 1;
                        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
                    });
                    setRequestedDocs(sorted);
                }
            }

            if (ctxRes.status === 'fulfilled') {
                const ctxJson = await ctxRes.value.json();
                if (ctxJson?.success && ctxJson.data) {
                    setStep3Ctx(ctxJson.data);
                }
            }
        } catch {
            setApiError('Failed to load data');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => { loadPageData(); }, [leadId]);

    // Auto-poll consent when waiting
    useEffect(() => {
        const waitingStatuses = ['link_sent', 'link_opened', 'esign_in_progress'];
        if (!waitingStatuses.includes(consentStatus)) return;
        const interval = setInterval(() => loadPageData(true), 10000);
        return () => clearInterval(interval);
    }, [consentStatus, leadId]);

    // Detect consent path
    useEffect(() => {
        const digitalStatuses = ['link_sent', 'link_opened', 'esign_in_progress', 'esign_completed'];
        const manualStatuses = ['consent_generated', 'consent_uploaded'];
        if (digitalStatuses.includes(consentStatus)) setConsentPath('digital');
        else if (manualStatuses.includes(consentStatus)) setConsentPath('manual');
    }, [consentStatus]);

    // Auto-save every 2 minutes
    useEffect(() => {
        const interval = setInterval(() => {
            if (!loading && !accessDenied) handleSaveDraft(true);
        }, 120000);
        return () => clearInterval(interval);
    }, [loading, accessDenied, borrowerForm, consentStatus]);

    // ─── Borrower Form Helpers ─────────────────────────────────────────────

    const updateField = (field: string, value: any) => {
        let fin = value;
        if (['full_name', 'father_or_husband_name'].includes(field)) {
            // Strip digits and other non-name characters; allow letters, spaces, dots, apostrophes, hyphens
            const lettersOnly = String(value ?? '').replace(/[^A-Za-z\s.'-]/g, '');
            fin = lettersOnly.split(' ').map((s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')).join(' ');
        }
        if (field === 'phone') {
            fin = String(value ?? '').replace(/\D/g, '').slice(0, 10);
        }
        if (field === 'aadhaar_no') {
            fin = String(value ?? '').replace(/\D/g, '').slice(0, 12);
        }
        if (field === 'pan_no') {
            fin = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        }
        setBorrowerForm(prev => {
            const next = { ...prev, [field]: fin };
            if (field === 'is_current_same' && fin) next.current_address = next.permanent_address;
            if (field === 'permanent_address' && next.is_current_same) next.current_address = fin;
            return next;
        });
        // Clear inline error for this field as soon as user starts editing
        setBorrowerErrors(prev => {
            if (!prev[field]) return prev;
            const { [field]: _, ...rest } = prev;
            return rest;
        });
        // Live check: co-borrower phone must differ from primary applicant phone
        if (field === 'phone' && /^\d{10}$/.test(fin)) {
            const primaryPhone = String(lead?.phone || lead?.owner_contact || '').replace(/\D/g, '').slice(-10);
            if (primaryPhone && primaryPhone === fin) {
                setBorrowerErrors(prev => ({
                    ...prev,
                    phone: "Co-borrower phone must differ from customer's mobile number",
                }));
            }
        }
    };

    // ─── Co-borrower Form Validation ───────────────────────────────────────

    const validateBorrowerForm = (): { ok: boolean; errors: Record<string, string> } => {
        const errs: Record<string, string> = {};
        const f = borrowerForm;

        // Full Name — required, min 2 chars (after trim)
        if (!f.full_name.trim()) errs.full_name = 'Full name is required';
        else if (f.full_name.trim().length < 2) errs.full_name = 'Full name must be at least 2 characters';

        // Father / Husband — required
        if (!f.father_or_husband_name.trim()) errs.father_or_husband_name = "Father / Husband name is required";

        // DOB — valid date, age >= 18
        if (!f.dob) errs.dob = 'Date of birth is required';
        else {
            const d = new Date(f.dob);
            if (Number.isNaN(d.getTime())) errs.dob = 'Invalid date';
            else {
                const today = new Date();
                let age = today.getFullYear() - d.getFullYear();
                const m = today.getMonth() - d.getMonth();
                if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
                if (age < 18) errs.dob = 'Co-borrower must be at least 18 years old';
            }
        }

        // Phone — exactly 10 digits, must NOT match primary applicant phone
        if (!f.phone) errs.phone = 'Phone is required';
        else if (!/^\d{10}$/.test(f.phone)) errs.phone = 'Phone must be exactly 10 digits';
        else {
            const primaryPhone = String(lead?.phone || lead?.owner_contact || '').replace(/\D/g, '').slice(-10);
            if (primaryPhone && primaryPhone === f.phone) {
                errs.phone = "Co-borrower phone must differ from customer's mobile number";
            }
        }

        // Permanent Address — required
        if (!f.permanent_address.trim()) errs.permanent_address = 'Permanent address is required';

        // Current Address — required
        if (!f.current_address.trim()) errs.current_address = 'Current address is required';

        // PAN — required, format AAAAA9999A
        if (!f.pan_no.trim()) errs.pan_no = 'PAN is required';
        else if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(f.pan_no.trim())) errs.pan_no = 'PAN format must be AAAAA9999A';

        // Aadhaar — required, 12 digits
        if (!f.aadhaar_no) errs.aadhaar_no = 'Aadhaar is required';
        else if (!/^\d{12}$/.test(f.aadhaar_no)) errs.aadhaar_no = 'Aadhaar must be exactly 12 digits';

        // Relationship — required, one of allowed enums
        if (!f.relationship) errs.relationship = 'Relationship is required';
        else if (!['spouse', 'parent', 'sibling', 'other'].includes(f.relationship)) errs.relationship = 'Invalid relationship';

        return { ok: Object.keys(errs).length === 0, errors: errs };
    };

    // ─── Document Stats ────────────────────────────────────────────────────

    const requiredDocs = useMemo(() => {
        const assetModel = String(lead?.asset_model || lead?.asset_category || '').toUpperCase();
        const isVehicle = ['2W', '3W', '4W'].includes(assetModel);
        return FINANCE_DOCUMENTS.map(doc =>
            doc.key === 'rc_copy' ? { ...doc, required: isVehicle } : doc
        );
    }, [lead]);

    const docStats = useMemo(() => {
        const required = requiredDocs.filter(d => d.required);
        const uploaded = required.filter(d => uploadedDocs[d.key]?.file_url);
        const pending = required.filter(d => !uploadedDocs[d.key]?.file_url);
        return { total: required.length, uploadedCount: uploaded.length, pending };
    }, [requiredDocs, uploadedDocs]);

    // ─── Document Upload ───────────────────────────────────────────────────

    const handleDocUpload = async (documentType: string, file: File) => {
        if (!['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'].includes(file.type)) {
            setApiError('Only PNG, JPEG, JPG, and PDF files are allowed');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setApiError('File size must be 5MB or smaller');
            return;
        }

        setUploadedDocs(prev => ({
            ...prev,
            [documentType]: { ...(prev[documentType] || {}), doc_type: documentType, verification_status: 'pending', doc_status: 'uploaded', file_url: prev[documentType]?.file_url || null },
        }));

        try {
            setApiError(null);
            const formData = new FormData();
            formData.append('file', file);
            formData.append('documentType', documentType);
            formData.append('docType', documentType);
            formData.append('docFor', 'borrower');

            const res = await fetch(`/api/kyc/${leadId}/upload-document`, { method: 'POST', body: formData });
            const data = await res.json();

            if (!res.ok || !data?.success) throw new Error(data?.message || data?.error?.message || 'Upload failed');

            const serverDoc = data?.document || data?.data || null;
            setUploadedDocs(prev => ({
                ...prev,
                [documentType]: {
                    ...(prev[documentType] || {}),
                    doc_type: documentType,
                    doc_status: serverDoc?.doc_status || 'uploaded',
                    verification_status: serverDoc?.verification_status || 'uploaded',
                    file_url: serverDoc?.file_url || data?.fileUrl || prev[documentType]?.file_url || null,
                    file_name: serverDoc?.file_name || file.name,
                    file_size: serverDoc?.file_size || file.size,
                    uploaded_at: serverDoc?.uploaded_at || new Date().toISOString(),
                },
            }));
            await loadPageData(true);
        } catch (err: any) {
            setApiError(err?.message || 'Document upload failed');
        }
    };

    // ─── Aadhaar OCR Auto-fill ─────────────────────────────────────────────

    const handleOCRResult = (data: any) => {
        if (!data) return;
        if (data.full_name) updateField('full_name', data.full_name);
        if (data.father_or_husband_name) updateField('father_or_husband_name', data.father_or_husband_name);
        if (data.phone) updateField('phone', data.phone);
        if (data.dob) updateField('dob', data.dob);
        if (data.current_address) updateField('current_address', data.current_address);
        if (data.permanent_address) updateField('permanent_address', data.permanent_address);
        const aadhaar = data.aadhaar_number ?? data.aadhaar_no ?? data.aadhaar;
        if (aadhaar) updateField('aadhaar_no', String(aadhaar));
    };

    // ─── Co-Borrower Coupon (BRD §2.9.3.6) ─────────────────────────────────
    // We reuse the existing /api/kyc/[leadId]/validate-coupon endpoint.
    // The "co-borrower coupon" concept in BRD is satisfied here because coupon
    // and lead are 1:1 in the current schema — the dealer applies a coupon on
    // the lead specifically to authorise re-verification with co-borrower.

    const handleValidateCbCoupon = async () => {
        if (!cbCouponCode.trim()) { setApiError('Please enter coupon code'); return; }
        setCbCouponValidating(true);
        setCbCouponResult(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/validate-coupon`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ couponCode: cbCouponCode.trim() }),
            });
            const data = await res.json();
            setCbCouponResult(data);
            if (!(data.success || data.valid)) {
                setApiError(data.message || data.error || 'Invalid coupon');
            }
        } catch {
            setApiError('Coupon validation failed');
        } finally {
            setCbCouponValidating(false);
        }
    };

    const handleReleaseCbCoupon = async () => {
        setCbReleasingCoupon(true);
        setApiError(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/release-coupon`, { method: 'POST' });
            const data = await res.json();
            if (data.success) { setCbCouponCode(''); setCbCouponResult(null); }
            else setApiError(data.error?.message || 'Failed to release coupon');
        } catch {
            setApiError('Failed to release coupon');
        } finally {
            setCbReleasingCoupon(false);
        }
    };

    // ─── Admin-Requested Document Upload ───────────────────────────────────

    const handleRequestedDocUpload = async (requestId: string, file: File) => {
        if (!['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'].includes(file.type)) {
            setApiError('Only PNG, JPEG, JPG, and PDF files are allowed');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setApiError('File size must be 5MB or smaller');
            return;
        }
        setRequestedUploading(prev => ({ ...prev, [requestId]: true }));
        try {
            setApiError(null);
            const formData = new FormData();
            formData.append('file', file);
            formData.append('requestId', requestId);
            const res = await fetch(`/api/kyc/${leadId}/requested-docs`, { method: 'POST', body: formData });
            const json = await res.json();
            if (!res.ok || !json?.success) throw new Error(json?.error?.message || 'Upload failed');
            await loadPageData(true);
        } catch (err: any) {
            setApiError(err?.message || 'Upload failed');
        } finally {
            setRequestedUploading(prev => ({ ...prev, [requestId]: false }));
        }
    };

    // ─── Save Draft ────────────────────────────────────────────────────────

    const handleSaveDraft = async (auto = false) => {
        try {
            setSavingDraft(true);
            const res = await fetch(`/api/kyc/${leadId}/save-draft`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ step: 3, data: { borrowerForm, documents: uploadedDocs, consentStatus } }),
            });
            if (!res.ok) throw new Error('Failed to save draft');
            setLastSaved(`${auto ? 'Auto-saved' : 'Saved'} at ${new Date().toLocaleTimeString()}`);
        } catch (err: any) {
            setApiError(err?.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    // ─── Consent Handlers ──────────────────────────────────────────────────

    const handleSendConsent = async (channel: 'sms' | 'whatsapp') => {
        try {
            setApiError(null);
            setConsentLoading(true);
            setConsentPath('digital');
            const res = await fetch(`/api/kyc/${leadId}/send-consent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel, consent_for: 'borrower' }),
            });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.error?.message || data?.message || 'Failed to send consent');
            setConsentStatus('link_sent');
        } catch (err: any) {
            setApiError(err?.message || 'Failed to send consent');
            setConsentPath('none');
        } finally {
            setConsentLoading(false);
        }
    };

    const handleGenerateConsentPDF = async () => {
        try {
            setApiError(null);
            setConsentLoading(true);
            setConsentPath('manual');
            const res = await fetch(`/api/kyc/${leadId}/generate-consent-pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ consent_for: 'borrower' }),
            });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.error?.message || data?.message || 'Failed to generate consent PDF');
            setConsentStatus('consent_generated');
            setConsentPdfUrl(data.pdfUrl || null);
            if (data.pdfUrl) {
                try {
                    const pdfRes = await fetch(data.pdfUrl);
                    const blob = await pdfRes.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = `consent_${leadId}.pdf`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(blobUrl);
                } catch {
                    // Fallback: open in new tab if blob download fails
                    window.open(data.pdfUrl, '_blank');
                }
            }
        } catch (err: any) {
            setApiError(err?.message || 'Failed to generate consent PDF');
            setConsentPath('none');
        } finally {
            setConsentLoading(false);
        }
    };

    const handleUploadSignedConsent = async (file: File) => {
        try {
            setApiError(null);
            setConsentLoading(true);
            if (file.type !== 'application/pdf') throw new Error('Only PDF files allowed');
            if (file.size > 10 * 1024 * 1024) throw new Error('Max 10MB');
            const formData = new FormData();
            formData.append('file', file);
            formData.append('consent_for', 'borrower');
            const res = await fetch(`/api/kyc/${leadId}/upload-signed-consent`, { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.error?.message || data?.message || 'Upload failed');
            setConsentStatus('admin_review_pending');
        } catch (err: any) {
            setApiError(err?.message || 'Failed to upload signed consent');
        } finally {
            setConsentLoading(false);
        }
    };

    // ─── Save & Next ───────────────────────────────────────────────────────

    // ─── Submit for Verification (BRD §2.9.3.7) ────────────────────────────
    // Replaces the old "Save & Next" pattern. Sends Step 3 back to admin and
    // sets lead.kyc_status = 'pending_itarang_reverification'. Step 4 stays
    // locked until admin approves.

    const handleSubmitForVerification = async () => {
        try {
            setSubmitting(true);
            setApiError(null);

            // Validate co-borrower form when co-borrower is required
            if (step3Ctx?.requires_co_borrower) {
                const { ok, errors } = validateBorrowerForm();
                if (!ok) {
                    setBorrowerErrors(errors);
                    setApiError('Please fix the highlighted fields in Co-borrower Details before submitting.');
                    return;
                }
                setBorrowerErrors({});
            }

            // Save draft first so the dealer doesn't lose work if submit fails
            await fetch(`/api/kyc/${leadId}/save-draft`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ step: 3, data: { borrowerForm, documents: uploadedDocs, consentStatus } }),
            });

            // Submit. The submit-verification endpoint now also flips
            // lead.kyc_status to 'pending_itarang_reverification' and inserts
            // a high-priority adminVerificationQueue row.
            const res = await fetch(`/api/coborrower/${leadId}/submit-verification`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok || !data.success) {
                setApiError(data?.error?.message || data?.message || 'Submission failed.');
                return;
            }

            toast.success('Submitted for verification. Admin will review and you will be notified.');
            await loadPageData(true);
        } catch (err: any) {
            setApiError(err?.message || 'Failed to submit for verification');
        } finally {
            setSubmitting(false);
        }
    };

    // ─── Render ────────────────────────────────────────────────────────────

    if (loading) return <FullPageLoader />;

    if (accessDenied) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
                <div className="text-center max-w-md">
                    <Shield className="w-14 h-14 text-red-400 mx-auto mb-4" />
                    <h2 className="text-2xl font-bold text-gray-900">Access Denied</h2>
                    <p className="mt-2 text-sm text-gray-500">
                        {apiError || 'Step 3 is only available for hot leads with non-cash payment method.'}
                    </p>
                    <button onClick={() => router.push('/dealer-portal/leads/new')} className="mt-6 px-6 py-3 bg-[#0047AB] text-white rounded-xl font-bold">Back to Lead Creation</button>
                </div>
            </div>
        );
    }

    // BRD §2.9.3 — Step 3 was previously conditional on admin requesting co-borrower
    // KYC or additional docs. Team lead requirement: render Step 3 unconditionally so
    // it's reachable from the Step 2 progress arrow regardless of admin request state.

    // ─── Gating & Stepper ───────────────────────────────────────────────────
    const isConsentVerified = ['verified', 'admin_verified', 'manual_verified'].includes((consentStatus || '').toLowerCase());
    const allDocsUploaded = requiredDocs.filter(d => d.required).every(d => !!uploadedDocs[d.key]?.file_url);

    // Admin-requested documents (Other Documentation section)
    const showOtherDocs =
        ['awaiting_additional_docs', 'awaiting_both', 'pending_itarang_reverification'].includes(lead?.kyc_status || '')
        || requestedDocs.length > 0;
    const requiredRequestedDocs = requestedDocs.filter(d => d.is_required);
    const requestedDocsAllCount = requestedDocs.length;
    const requestedDocsUploadedCount = requestedDocs.filter(d => !!d.file_url && d.upload_status !== 'rejected').length;
    const requestedDocsVerifiedCount = requestedDocs.filter(d => d.upload_status === 'verified').length;
    const requestedDocsRejectedCount = requestedDocs.filter(d => d.upload_status === 'rejected').length;
    const allRequiredRequestedUploaded = requiredRequestedDocs.every(d => !!d.file_url && d.upload_status !== 'rejected');
    const pendingRequiredRequestedCount = requiredRequestedDocs.filter(d => !d.file_url || d.upload_status === 'rejected').length;

    // BRD §2.9.3.7 — Submit gating matrix:
    //   Supporting docs only      → all required supporting docs uploaded
    //   Co-borrower KYC only      → form valid + 11 docs + consent + coupon
    //   Both                      → both of the above
    const pendingRequirements: string[] = [];
    const cbCouponReserved = !!(cbCouponResult?.success || cbCouponResult?.valid || cbCouponResult?.status === 'reserved' || cbCouponResult?.status === 'used');
    const alreadySubmitted = step3Ctx?.lead_kyc_status === 'pending_itarang_reverification';

    if (step3Ctx?.requires_co_borrower) {
        if (!isConsentVerified) pendingRequirements.push('co-borrower consent verification');
        if (!allDocsUploaded) pendingRequirements.push(`${docStats.pending.length} pending co-borrower document${docStats.pending.length === 1 ? '' : 's'}`);
        if (!cbCouponReserved) pendingRequirements.push('coupon validation');
    }
    if (step3Ctx?.requires_supporting_docs && requestedDocs.length > 0 && !allRequiredRequestedUploaded) {
        pendingRequirements.push(`${pendingRequiredRequestedCount} admin-requested document${pendingRequiredRequestedCount === 1 ? '' : 's'}`);
    }

    const canSubmit = (() => {
        if (alreadySubmitted) return false;
        if (!step3Ctx) return false;
        const supportingOk = !step3Ctx.requires_supporting_docs || requestedDocs.length === 0 || allRequiredRequestedUploaded;
        const coBorrowerOk = !step3Ctx.requires_co_borrower || (
            isConsentVerified && allDocsUploaded && cbCouponReserved
        );
        return supportingOk && coBorrowerOk;
    })();
    const stepRoutes: Record<number, string> = {
        1: '/dealer-portal/leads/new',
        2: `/dealer-portal/leads/${leadId}/kyc`,
        3: `/dealer-portal/leads/${leadId}/borrower-consent`,
        4: `/dealer-portal/leads/${leadId}/product-selection`,
        5: `/dealer-portal/leads/${leadId}/step-5`,
    };
    const jumpToStep = (target: number) => {
        if (target === 3) return;
        // Each step has its own access gate (e.g. /api/lead/:id/step-4-access)
        // that redirects back when the dealer isn't eligible. Don't block
        // navigation here — let the destination step decide.
        const route = stepRoutes[target];
        if (route) router.push(route);
    };

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            {/* OCR Modal — same Aadhaar autofill used on Step 1 */}
            <OCRModal open={showOCR} onClose={() => setShowOCR(false)} onResult={handleOCRResult} />

            {/* Preview Customer Profile (BRD §2.9.3 bottom-bar action) */}
            <PreviewProfileModal
                open={showPreview}
                onClose={() => setShowPreview(false)}
                lead={lead}
                borrowerForm={borrowerForm}
                includeCoBorrower={!!step3Ctx?.requires_co_borrower}
            />

            <div className="max-w-[1200px] mx-auto px-6 py-8 pb-40">
                {/* Header */}
                <ProgressHeader
                    title="Other Documents & Co-Borrower KYC"
                    subtitle={`Lead ID: ${leadId}${lead?.full_name ? ` — ${lead.full_name}` : ''}`}
                    step={3}
                    totalSteps={5}
                    workflowLabel="Interim Step"
                    onBack={() => router.push('/dealer-portal/leads/new')}
                    onPrev={() => jumpToStep(2)}
                    onNext={() => jumpToStep(4)}
                    onStepClick={jumpToStep}
                    rightAction={
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => setShowOCR(true)}
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:border-[#1D4ED8] hover:text-[#1D4ED8] text-sm font-bold text-gray-800 shadow-sm transition-all"
                            >
                                <Scan className="w-4 h-4" /> Auto-fill from ID
                            </button>
                            <button onClick={() => loadPageData(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold">
                                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
                            </button>
                        </div>
                    }
                />

                <ErrorBanner message={apiError} onDismiss={() => setApiError(null)} />

                {/* ─── Admin Request Banner (BRD §2.9.3) ────────────────── */}
                {step3Ctx && (
                    <>
                        {step3Ctx.is_replacement ? (
                            <div className="mb-6 flex items-start gap-3 px-4 py-4 rounded-xl bg-red-50 border-2 border-red-200">
                                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                                <div className="flex-1 text-sm">
                                    <p className="font-bold text-red-800">
                                        Previous co-borrower rejected (attempt #{step3Ctx.latest_co_borrower_request?.attempt_number ?? 2})
                                    </p>
                                    {step3Ctx.latest_co_borrower_request?.reason && (
                                        <p className="text-red-700 mt-0.5">
                                            <span className="font-semibold">Reason: </span>
                                            <span className="italic">{step3Ctx.latest_co_borrower_request.reason}</span>
                                        </p>
                                    )}
                                    <p className="text-red-600 mt-1 text-xs">Please submit a new co-borrower below.</p>
                                </div>
                            </div>
                        ) : (step3Ctx.requires_supporting_docs || step3Ctx.requires_co_borrower) ? (
                            <div className="mb-6 flex items-start gap-3 px-4 py-4 rounded-xl bg-blue-50 border border-blue-200">
                                <FileText className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                                <div className="flex-1 text-sm">
                                    <p className="font-bold text-blue-900">Admin has requested:</p>
                                    <ul className="mt-1.5 space-y-1 text-blue-800">
                                        {step3Ctx.requires_supporting_docs && (
                                            <li className="flex items-center gap-2">
                                                <span className="w-1.5 h-1.5 rounded-full bg-blue-600 flex-shrink-0" />
                                                Supporting Documents ({step3Ctx.supporting_docs_summary.total} item{step3Ctx.supporting_docs_summary.total === 1 ? '' : 's'})
                                            </li>
                                        )}
                                        {step3Ctx.requires_co_borrower && (
                                            <li className="flex items-center gap-2">
                                                <span className="w-1.5 h-1.5 rounded-full bg-blue-600 flex-shrink-0" />
                                                Co-Borrower KYC
                                                {step3Ctx.latest_co_borrower_request?.reason && (
                                                    <span className="italic text-blue-700"> — {step3Ctx.latest_co_borrower_request.reason}</span>
                                                )}
                                            </li>
                                        )}
                                    </ul>
                                    {step3Ctx.latest_co_borrower_request?.created_at && (
                                        <p className="text-xs text-blue-600 mt-2">
                                            Requested on {new Date(step3Ctx.latest_co_borrower_request.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                                        </p>
                                    )}
                                </div>
                            </div>
                        ) : null}

                        {step3Ctx.lead_kyc_status === 'pending_itarang_reverification' && (
                            <div className="mb-6 flex items-start gap-3 px-4 py-4 rounded-xl bg-emerald-50 border border-emerald-200">
                                <Clock className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                                <div className="flex-1 text-sm">
                                    <p className="font-bold text-emerald-800">Submitted — awaiting admin review</p>
                                    <p className="text-emerald-700 mt-0.5 text-xs">
                                        Step 3 has been submitted to iTarang admin. You'll be notified once admin completes the review.
                                    </p>
                                </div>
                            </div>
                        )}
                    </>
                )}

                <main className="grid grid-cols-1 gap-6">
                    {/* ─── Section B — Co-Borrower KYC (BRD §2.9.3.5) ──────
                        Visible only when admin requested co-borrower KYC. */}
                    {step3Ctx?.requires_co_borrower && (<>
                    {/* ─── Co-borrower Details (Editable) ───────────────── */}
                    <SectionCard title="Co-borrower Details">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                            <InputField label="Full Name" value={borrowerForm.full_name} onChange={v => updateField('full_name', v)} placeholder="John Doe" required error={borrowerErrors.full_name} />
                            <InputField label="Father / Husband Name" value={borrowerForm.father_or_husband_name} onChange={v => updateField('father_or_husband_name', v)} placeholder="Richard Doe" required error={borrowerErrors.father_or_husband_name} />
                            <InputField label="Date of Birth" type="date" value={borrowerForm.dob} onChange={v => updateField('dob', v)} required error={borrowerErrors.dob} />
                            <InputField label="Phone" value={borrowerForm.phone} onChange={v => updateField('phone', v)} placeholder="9876543210" required inputMode="numeric" maxLength={10} error={borrowerErrors.phone} />
                            <InputField label="Email" value={borrowerForm.email} onChange={v => updateField('email', v)} placeholder="john@email.com" />
                            <InputField label="PAN Number" value={borrowerForm.pan_no} onChange={v => updateField('pan_no', v)} placeholder="ABCDE1234F" required maxLength={10} error={borrowerErrors.pan_no} />
                            <InputField label="Aadhaar Number" value={borrowerForm.aadhaar_no} onChange={v => updateField('aadhaar_no', v)} placeholder="123456789012" required inputMode="numeric" maxLength={12} error={borrowerErrors.aadhaar_no} />
                            <SelectField
                                label="Relationship to Applicant"
                                value={borrowerForm.relationship}
                                onChange={v => updateField('relationship', v)}
                                options={[
                                    { value: 'spouse', label: 'Spouse' },
                                    { value: 'parent', label: 'Parent' },
                                    { value: 'sibling', label: 'Sibling' },
                                    { value: 'other', label: 'Other' },
                                ]}
                                placeholder="Select relationship"
                                required
                                error={borrowerErrors.relationship}
                            />
                            <InputField label="Marital Status" value={borrowerForm.marital_status} onChange={v => updateField('marital_status', v)} placeholder="Single / Married" />
                            <InputField label="Monthly Income (₹)" value={borrowerForm.income} onChange={v => updateField('income', v)} placeholder="50000" />
                            <div className="md:col-span-2">
                                <InputField label="Permanent Address" value={borrowerForm.permanent_address} onChange={v => updateField('permanent_address', v)} placeholder="Full permanent address" required error={borrowerErrors.permanent_address} />
                            </div>
                            <div className="md:col-span-2 space-y-2">
                                <div className="flex items-center justify-between">
                                    <label className="text-sm font-bold text-gray-900 px-1">
                                        Current Address <span className="text-red-500">*</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-gray-600">
                                        <input type="checkbox" checked={borrowerForm.is_current_same} onChange={e => updateField('is_current_same', e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-[#0047AB]" />
                                        Same as permanent
                                    </label>
                                </div>
                                <input
                                    value={borrowerForm.current_address}
                                    disabled={borrowerForm.is_current_same}
                                    onChange={e => updateField('current_address', e.target.value)}
                                    className={`w-full h-11 px-4 bg-white border-2 rounded-xl outline-none text-sm transition-all ${
                                        borrowerForm.is_current_same ? 'bg-gray-50 border-gray-100 text-gray-400' :
                                        borrowerErrors.current_address ? 'border-red-400' :
                                        'border-[#EBEBEB] focus:border-[#1D4ED8]'
                                    }`}
                                    placeholder="Current address"
                                />
                                {borrowerErrors.current_address && (
                                    <p className="text-xs text-red-500 px-1">{borrowerErrors.current_address}</p>
                                )}
                            </div>
                        </div>
                    </SectionCard>

                    {/* ─── Co-borrower Consent ────────────────────────────── */}
                    <SectionCard title="Co-borrower Consent" action={
                        <ConsentStatusBadge status={consentStatus} />
                    }>
                        <div className="mb-4 flex items-center gap-2 text-sm">
                            <Phone className="w-4 h-4 text-gray-500" />
                            <span className="text-gray-500">Consent link will be sent to:</span>
                            <span className="font-bold text-gray-900">{borrowerForm.phone || '—'}</span>
                        </div>
                        {isFinalConsentStatus(consentStatus) ? (
                            <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                                <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                                <div>
                                    <p className="text-sm font-bold text-emerald-800">Consent Verified</p>
                                    <p className="text-xs text-emerald-600 mt-0.5">Admin has verified the co-borrower consent. You can proceed to the next step.</p>
                                </div>
                            </div>
                        ) : consentStatus === 'admin_review_pending' ? (
                            <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                                <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                                <div>
                                    <p className="text-sm font-bold text-amber-800">Awaiting Admin Verification</p>
                                    <p className="text-xs text-amber-600 mt-0.5">Signed consent has been uploaded and is pending admin review. You will be notified once verified.</p>
                                </div>
                            </div>
                        ) : consentStatus === 'esign_failed' ? (
                            <div className="space-y-4">
                                <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
                                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-bold text-red-800">Aadhaar eSign Failed</p>
                                        <p className="text-xs text-red-600 mt-0.5">Co-borrower eSign was unsuccessful. You can resend the consent link or switch to manual consent.</p>
                                    </div>
                                </div>
                                <div className="flex gap-3 items-start">
                                    <div className="flex flex-col">
                                        <button
                                            onClick={() => handleSendConsent('whatsapp')}
                                            disabled={true}
                                            className="px-5 py-2.5 bg-[#25D366] text-white rounded-xl text-sm font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Send className="w-4 h-4" /> Resend via WhatsApp
                                        </button>
                                        <span className="text-[10px] text-gray-500 font-medium text-center mt-1">Coming Soon</span>
                                    </div>
                                    <button onClick={handleGenerateConsentPDF} disabled={consentLoading}
                                        className="px-5 py-2.5 bg-white border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-50 flex items-center gap-2">
                                        <FileText className="w-4 h-4" /> Switch to Manual
                                    </button>
                                </div>
                            </div>
                        ) : consentStatus === 'esign_blocked' ? (
                            <div className="space-y-4">
                                <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
                                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-bold text-red-800">Digital Consent Blocked</p>
                                        <p className="text-xs text-red-600 mt-0.5">Maximum eSign attempts (3) reached. Please use manual consent.</p>
                                    </div>
                                </div>
                                <button onClick={handleGenerateConsentPDF} disabled={consentLoading}
                                    className="px-5 py-2.5 bg-teal-600 text-white rounded-xl text-sm font-bold hover:bg-teal-700 transition-all disabled:opacity-50 flex items-center gap-2">
                                    {consentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Generate Manual Consent PDF
                                </button>
                            </div>
                        ) : consentStatus === 'expired' ? (
                            <div className="space-y-4">
                                <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                                    <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-bold text-amber-800">Consent Link Expired</p>
                                        <p className="text-xs text-amber-600 mt-0.5">The consent link has expired (24 hours). Please resend.</p>
                                    </div>
                                </div>
                                <div className="flex gap-3 items-start">
                                    <div className="flex flex-col">
                                        <button
                                            onClick={() => handleSendConsent('whatsapp')}
                                            disabled={true}
                                            className="px-5 py-2.5 bg-[#25D366] text-white rounded-xl text-sm font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Send className="w-4 h-4" /> Resend via WhatsApp
                                        </button>
                                        <span className="text-[10px] text-gray-500 font-medium text-center mt-1">Coming Soon</span>
                                    </div>
                                    <button onClick={() => handleSendConsent('sms')} disabled={consentLoading}
                                        className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center gap-2">
                                        {consentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Resend via SMS
                                    </button>
                                </div>
                            </div>
                        ) : consentStatus === 'esign_completed' ? (
                            <div className="space-y-3">
                                <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                                    <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                                        <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-emerald-800">Co-borrower Signed Successfully</p>
                                        <p className="text-xs text-emerald-600 mt-0.5">The co-borrower has completed Aadhaar eSign. Consent is now pending admin verification.</p>
                                        {consentRecord?.signed_at && (
                                            <p className="text-xs text-emerald-500 mt-1">
                                                Signed at: {new Date(consentRecord.signed_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                                                {consentRecord.signer_aadhaar_masked && ` · Aadhaar: ${consentRecord.signer_aadhaar_masked}`}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex-shrink-0">
                                        <span className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold">
                                            <CheckCircle2 className="w-3.5 h-3.5" /> Signed
                                        </span>
                                    </div>
                                </div>
                                {consentRecord?.signed_consent_url && (
                                    <a href={consentRecord.signed_consent_url} target="_blank" rel="noopener noreferrer"
                                        className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-emerald-200 rounded-lg text-xs font-bold text-emerald-700 hover:bg-emerald-50 transition-all">
                                        <Download className="w-3.5 h-3.5" /> Download Signed Consent PDF
                                    </a>
                                )}
                            </div>
                        ) : consentStatus === 'esign_in_progress' ? (
                            <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                                    <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
                                </div>
                                <div className="flex-1">
                                    <p className="text-sm font-bold text-blue-800">Co-borrower is Signing...</p>
                                    <p className="text-xs text-blue-600 mt-0.5">Co-borrower has opened the consent link and is completing the Aadhaar eSign process. This page will update automatically.</p>
                                </div>
                            </div>
                        ) : consentStatus === 'admin_rejected' ? (
                            <div className="space-y-4">
                                <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
                                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-bold text-red-800">Consent Rejected by Admin</p>
                                        {consentRecord?.rejection_reason && (
                                            <p className="text-xs text-red-700 mt-1 font-medium">Reason: {consentRecord.rejection_reason}</p>
                                        )}
                                        <p className="text-xs text-red-600 mt-0.5">Please re-generate and re-upload the consent form, or resend digital consent.</p>
                                    </div>
                                </div>
                                <div className="flex gap-3 items-start">
                                    <div className="flex flex-col">
                                        <button
                                            onClick={() => handleSendConsent('whatsapp')}
                                            disabled={true}
                                            className="px-5 py-2.5 bg-[#25D366] text-white rounded-xl text-sm font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Send className="w-4 h-4" /> Resend Digital
                                        </button>
                                        <span className="text-[10px] text-gray-500 font-medium text-center mt-1">Coming Soon</span>
                                    </div>
                                    <button onClick={handleGenerateConsentPDF} disabled={consentLoading}
                                        className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center gap-2">
                                        {consentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                                        Re-generate Manual PDF
                                    </button>
                                </div>
                            </div>
                        ) : (
                            /* ── Choose Consent Path ──────────────────────── */
                            <div className="space-y-4">
                                <p className="text-sm text-gray-500">Choose one method to obtain co-borrower consent. Both options are mutually exclusive.</p>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {/* Digital Consent Card */}
                                    <div className={`relative p-5 rounded-2xl border-2 transition-all ${
                                        consentPath === 'digital'
                                            ? 'border-[#0047AB] bg-blue-50/50 shadow-md'
                                            : consentPath === 'manual'
                                                ? 'border-gray-100 bg-gray-50 opacity-50 pointer-events-none'
                                                : 'border-gray-200 bg-white hover:border-[#0047AB] hover:shadow-md cursor-pointer'
                                    }`}>
                                        <div className="flex items-start gap-3 mb-3">
                                            <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
                                                <Send className="w-5 h-5 text-[#0047AB]" />
                                            </div>
                                            <div>
                                                <h4 className="text-sm font-bold text-gray-900">Digital Consent (Aadhaar eSign)</h4>
                                                <p className="text-xs text-gray-500 mt-0.5">Send consent link via SMS/WhatsApp. Co-borrower signs digitally with Aadhaar OTP.</p>
                                            </div>
                                        </div>
                                        {consentPath !== 'manual' && (
                                            <div className="flex gap-2 items-start">
                                                <div className="flex-1 flex flex-col">
                                                    <button
                                                        onClick={() => handleSendConsent('whatsapp')}
                                                        disabled={true}
                                                        className="w-full px-3 py-2 bg-[#25D366] text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                                                    >
                                                        <Send className="w-3 h-3" />
                                                        WhatsApp
                                                    </button>
                                                    <span className="text-[10px] text-gray-500 font-medium text-center mt-1">Coming Soon</span>
                                                </div>
                                                <button onClick={() => handleSendConsent('sms')} disabled={consentLoading || consentPath === 'digital'}
                                                    className="flex-1 px-3 py-2 bg-[#0047AB] text-white rounded-lg text-xs font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center justify-center gap-1.5">
                                                    {consentLoading && consentPath === 'digital' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                                    SMS
                                                </button>
                                            </div>
                                        )}
                                        {(consentStatus === 'link_sent' || consentStatus === 'link_opened') && (
                                            <div className="mt-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2">
                                                <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                                                </span>
                                                <p className="text-xs font-medium text-amber-700">
                                                    {consentStatus === 'link_opened' ? 'Co-borrower opened the link. Waiting for signature...' : 'Consent link sent. Waiting for co-borrower to sign...'}
                                                    <span className="text-amber-500 ml-1">(auto-updating)</span>
                                                </p>
                                            </div>
                                        )}
                                    </div>

                                    {/* Manual Consent Card */}
                                    <div className={`relative p-5 rounded-2xl border-2 transition-all ${
                                        consentPath === 'manual'
                                            ? 'border-[#0047AB] bg-blue-50/50 shadow-md'
                                            : consentPath === 'digital'
                                                ? 'border-gray-100 bg-gray-50 opacity-50 pointer-events-none'
                                                : 'border-gray-200 bg-white hover:border-[#0047AB] hover:shadow-md cursor-pointer'
                                    }`}>
                                        <div className="flex items-start gap-3 mb-3">
                                            <div className="w-10 h-10 rounded-xl bg-teal-100 flex items-center justify-center flex-shrink-0">
                                                <FileText className="w-5 h-5 text-teal-700" />
                                            </div>
                                            <div>
                                                <h4 className="text-sm font-bold text-gray-900">Manual Consent (Signed PDF)</h4>
                                                <p className="text-xs text-gray-500 mt-0.5">Generate PDF, print, get co-borrower signature, scan and upload.</p>
                                            </div>
                                        </div>
                                        {consentPath !== 'digital' && (
                                            <div className="space-y-2">
                                                <button onClick={handleGenerateConsentPDF}
                                                    disabled={consentLoading || consentStatus === 'consent_generated' || consentStatus === 'consent_uploaded'}
                                                    className="w-full px-3 py-2 bg-teal-600 text-white rounded-lg text-xs font-bold hover:bg-teal-700 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5">
                                                    {consentLoading && consentPath === 'manual' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                                                    {consentStatus === 'consent_generated' ? 'PDF Generated' : 'Generate Consent PDF'}
                                                </button>

                                                {(consentStatus === 'consent_generated' || consentPdfUrl) && (
                                                    <>
                                                        {consentPdfUrl && (
                                                            <div className="p-2.5 bg-green-50 border border-green-200 rounded-lg">
                                                                <p className="text-xs text-green-700 font-medium"><CheckCircle2 className="w-3 h-3 inline mr-1" />PDF downloaded. Print, get signature, then upload scanned copy below.</p>
                                                            </div>
                                                        )}
                                                        <label className="w-full px-3 py-2 bg-[#0047AB] text-white rounded-lg text-xs font-bold hover:bg-[#003580] transition-all cursor-pointer flex items-center justify-center gap-1.5">
                                                            <Upload className="w-3 h-3" /> Upload Signed Consent PDF
                                                            <input type="file" className="hidden" accept="application/pdf"
                                                                onChange={e => e.target.files?.[0] && handleUploadSignedConsent(e.target.files[0])} />
                                                        </label>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </SectionCard>

                    {/* ─── Co-borrower Documents ─────────────────────────── */}
                    <SectionCard title="Co-borrower Documents" action={
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-gray-500">Uploaded:</span>
                            <span className={`text-sm font-black ${docStats.uploadedCount === docStats.total ? 'text-emerald-600' : 'text-[#0047AB]'}`}>
                                {docStats.uploadedCount}/{docStats.total}
                            </span>
                            {docStats.uploadedCount === docStats.total && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                        </div>
                    }>
                        {/* Progress Bar */}
                        <div className="mb-5">
                            <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                        docStats.uploadedCount === docStats.total ? 'bg-emerald-500' : 'bg-[#0047AB]'
                                    }`}
                                    style={{ width: `${docStats.total > 0 ? (docStats.uploadedCount / docStats.total) * 100 : 0}%` }}
                                />
                            </div>
                            {docStats.pending.length > 0 && (
                                <p className="text-xs text-red-500 font-medium mt-2">
                                    Missing: {docStats.pending.map(d => d.label).join(', ')}
                                </p>
                            )}
                        </div>

                        {/* Document Cards Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                            {requiredDocs.map(doc => (
                                <DocumentCard
                                    key={doc.key}
                                    label={doc.label}
                                    required={doc.required}
                                    uploaded={!!uploadedDocs[doc.key]?.file_url}
                                    status={uploadedDocs[doc.key]?.doc_status || uploadedDocs[doc.key]?.verification_status}
                                    failedReason={uploadedDocs[doc.key]?.rejection_reason || uploadedDocs[doc.key]?.failed_reason}
                                    onUpload={file => handleDocUpload(doc.key, file)}
                                    fileUrl={uploadedDocs[doc.key]?.file_url}
                                />
                            ))}
                        </div>
                    </SectionCard>

                    {/* ─── Verification Status ────────────────────────── */}
                    <SectionCard title="Verification Status (Co-borrower)">
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-gray-100">
                                            <th className="text-left py-3 px-3 font-bold text-gray-900">Check</th>
                                            <th className="text-left py-3 px-3 font-bold text-gray-900">Status</th>
                                            <th className="text-left py-3 px-3 font-bold text-gray-900">Last Update</th>
                                            <th className="text-left py-3 px-3 font-bold text-gray-900">Action</th>
                                            <th className="text-left py-3 px-3 font-bold text-gray-900">Failed Reason</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {verifications.map((v, i) => (
                                            <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                                                <td className="py-3 px-3 font-medium text-gray-900">{v.label}</td>
                                                <td className="py-3 px-3"><StatusBadge status={v.status} /></td>
                                                <td className="py-3 px-3 text-gray-500 text-xs">
                                                    {v.last_update ? new Date(v.last_update).toLocaleString() : '-'}
                                                </td>
                                                <td className="py-3 px-3">
                                                    {v.status === 'success' || v.status === 'verified' ? (
                                                        <span className="text-green-600 font-bold text-xs">Verified</span>
                                                    ) : v.status === 'failed' ? (
                                                        <button
                                                            onClick={() => {/* re-upload trigger */}}
                                                            className="text-xs font-bold text-[#0047AB] hover:underline flex items-center gap-1"
                                                        >
                                                            <Upload className="w-3 h-3" /> Re-upload
                                                        </button>
                                                    ) : (
                                                        <span className="text-gray-400 text-xs">—</span>
                                                    )}
                                                </td>
                                                <td className="py-3 px-3 text-xs text-red-600">{v.failed_reason || '-'}</td>
                                            </tr>
                                        ))}
                                        {showOtherDocs && requestedDocs.length > 0 && (
                                            <tr className="border-b border-gray-50 bg-blue-50/40">
                                                <td className="py-3 px-3 font-bold text-gray-900">Additional Documents</td>
                                                <td className="py-3 px-3">
                                                    <div className="flex items-center gap-2">
                                                        <StatusBadge status={
                                                            requestedDocsRejectedCount > 0 ? 'failed'
                                                            : requestedDocsVerifiedCount === requestedDocsAllCount ? 'success'
                                                            : allRequiredRequestedUploaded ? 'awaiting_action'
                                                            : 'pending'
                                                        } />
                                                        <span className="text-xs font-medium text-gray-600">
                                                            {requestedDocsVerifiedCount}/{requestedDocsAllCount} verified
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="py-3 px-3 text-gray-500 text-xs">—</td>
                                                <td className="py-3 px-3">
                                                    <a
                                                        href="#other-documentation"
                                                        className="text-xs font-bold text-[#0047AB] hover:underline inline-flex items-center gap-1"
                                                    >
                                                        <Eye className="w-3 h-3" /> View
                                                    </a>
                                                </td>
                                                <td className="py-3 px-3 text-xs text-red-600">
                                                    {requestedDocsRejectedCount > 0
                                                        ? `${requestedDocsRejectedCount} doc${requestedDocsRejectedCount === 1 ? '' : 's'} rejected — see below`
                                                        : '-'}
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            <div className="mt-4 flex items-center gap-4 text-xs">
                                <span className="font-bold text-gray-500">Consent:</span>
                                <ConsentStatusBadge status={consentStatus} />
                            </div>
                    </SectionCard>
                    </>)}

                    {/* ─── Section A — Other Documentation (Admin-Requested) ──
                        Visible only when admin requested supporting documents. */}
                    {step3Ctx?.requires_supporting_docs && requestedDocs.length > 0 && (
                        <div id="other-documentation" className="scroll-mt-24">
                            <SectionCard
                                title="Other Documentation"
                                action={
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-gray-500">Uploaded:</span>
                                        <span className={`text-sm font-black ${requestedDocsUploadedCount === requestedDocsAllCount ? 'text-emerald-600' : 'text-[#0047AB]'}`}>
                                            {requestedDocsUploadedCount}/{requestedDocsAllCount}
                                        </span>
                                        {requestedDocsRejectedCount > 0 && (
                                            <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[11px] font-bold">
                                                <AlertCircle className="w-3 h-3" /> {requestedDocsRejectedCount} rejected
                                            </span>
                                        )}
                                    </div>
                                }
                            >
                                <p className="text-xs text-gray-500 mb-4">
                                    Admin has requested these additional documents. Upload each — they will be sent back to admin for review.
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {requestedDocs.map(doc => (
                                        <RequestedDocCard
                                            key={doc.id}
                                            doc={doc}
                                            uploading={!!requestedUploading[doc.id]}
                                            onUpload={(file) => handleRequestedDocUpload(doc.id, file)}
                                        />
                                    ))}
                                </div>
                                {pendingRequiredRequestedCount > 0 && (
                                    <p className="mt-4 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                                        Pending: {requiredRequestedDocs.filter(d => !d.file_url || d.upload_status === 'rejected').map(d => d.doc_label).join(', ')}
                                    </p>
                                )}
                            </SectionCard>
                        </div>
                    )}

                    {/* ─── Verification Action — Coupon (BRD §2.9.3.6) ────
                        Visible only when co-borrower KYC is requested. Supporting-
                        docs-only re-verification reuses the original lead coupon. */}
                    {step3Ctx?.requires_co_borrower && step3Ctx?.lead_kyc_status !== 'pending_itarang_reverification' && (
                        <SectionCard title="Verification Action" action={
                            cbCouponResult?.status === 'used'
                                ? <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Submitted</span>
                                : cbCouponResult?.status === 'reserved' || (cbCouponResult?.success || cbCouponResult?.valid)
                                    ? <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Shield className="w-3 h-3" />Reserved</span>
                                    : <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-bold">Awaiting Coupon</span>
                        }>
                            {(cbCouponResult?.success || cbCouponResult?.valid) ? (
                                <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                                    <Shield className="w-5 h-5 text-blue-600 flex-shrink-0" />
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-blue-800">
                                            Coupon Reserved: <span className="font-mono">{cbCouponResult.coupon_code || cbCouponCode}</span>
                                        </p>
                                        <p className="text-xs text-blue-500 mt-0.5">
                                            This coupon is locked to this lead. Click "Submit for Verification" below to start re-verification.
                                        </p>
                                    </div>
                                    <button
                                        onClick={handleReleaseCbCoupon}
                                        disabled={cbReleasingCoupon}
                                        className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-xs font-bold text-gray-600 hover:bg-gray-50 transition-all disabled:opacity-50 flex items-center gap-1.5"
                                    >
                                        {cbReleasingCoupon ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                        Change Coupon
                                    </button>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <p className="text-xs text-gray-500">
                                        Enter your verification coupon code to authorise re-verification with the co-borrower.
                                    </p>
                                    <div className="flex items-center gap-3">
                                        <input
                                            type="text"
                                            value={cbCouponCode}
                                            onChange={e => setCbCouponCode(e.target.value.toUpperCase())}
                                            placeholder="Enter coupon code (e.g., ITARANG-FREE)"
                                            maxLength={20}
                                            className="flex-1 h-11 px-4 bg-white border-2 border-[#EBEBEB] rounded-xl outline-none text-sm font-mono focus:border-[#1D4ED8] transition-all"
                                        />
                                        <button
                                            onClick={handleValidateCbCoupon}
                                            disabled={cbCouponValidating || !cbCouponCode.trim()}
                                            className="px-6 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center gap-2"
                                        >
                                            {cbCouponValidating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                                            Validate
                                        </button>
                                    </div>
                                    {cbCouponResult && !cbCouponResult.valid && !cbCouponResult.success && (
                                        <div className="px-4 py-2 bg-red-50 border border-red-200 rounded-xl">
                                            <p className="text-sm font-medium text-red-700">
                                                <AlertCircle className="w-4 h-4 inline mr-1" />
                                                {cbCouponResult.message || 'Invalid coupon code'}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </SectionCard>
                    )}
                </main>

                {/* ─── Bottom Bar ────────────────────────────────────── */}
                {!canSubmit && pendingRequirements.length > 0 && !alreadySubmitted && (
                    <div className="mt-6 flex items-center justify-end">
                        <p className="text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            Complete to submit: {pendingRequirements.join(', ')}
                        </p>
                    </div>
                )}
                <StickyBottomBar lastSaved={lastSaved}>
                    <OutlineButton onClick={() => router.push(`/dealer-portal/leads/${leadId}/kyc`)}>Back</OutlineButton>
                    <SecondaryButton onClick={() => handleSaveDraft(false)} loading={savingDraft}>Save Draft</SecondaryButton>
                    <SecondaryButton onClick={() => setShowPreview(true)}>
                        <Eye className="w-4 h-4" /> Preview Customer Profile
                    </SecondaryButton>
                    <PrimaryButton onClick={handleSubmitForVerification} loading={submitting} disabled={submitting || !canSubmit}>
                        {alreadySubmitted ? 'Submitted' : 'Submit for Verification'}
                    </PrimaryButton>
                </StickyBottomBar>
            </div>
        </div>
    );
}
