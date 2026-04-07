'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
    ChevronLeft, ChevronRight, Loader2, Upload, CheckCircle2, XCircle,
    AlertCircle, Clock, X, Send, Shield, RefreshCw, User, UserX,
    Scan, FileText, Sparkles, ArrowRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    SectionCard, InputField, DocumentCard, StatusBadge,
    ProgressHeader, StickyBottomBar, ErrorBanner,
    PrimaryButton, SecondaryButton, OutlineButton, OCRModal, FullPageLoader,
} from '@/components/dealer-portal/lead-wizard/shared';
import { CO_BORROWER_DOCS } from '@/components/dealer-portal/lead-wizard/constants';

const fadeSlideInitial = { opacity: 0, y: 20 };
const fadeSlideAnimate = { opacity: 1, y: 0 };
const fadeSlideExit = { opacity: 0, y: -10 };
const fadeSlideTransition = { duration: 0.35, ease: 'easeOut' as const };

export default function InterimStepPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [apiError, setApiError] = useState<string | null>(null);
    const [lastSaved, setLastSaved] = useState<string | null>(null);

    // Co-borrower toggle
    const [hasCoBorrower, setHasCoBorrower] = useState<boolean | null>(null);
    const [hasAdditionalDocs, setHasAdditionalDocs] = useState(false);

    // Co-borrower form
    const [coBorrowerForm, setCoBorrowerForm] = useState({
        full_name: '', father_or_husband_name: '', dob: '', phone: '',
        permanent_address: '', current_address: '', is_current_same: false,
        pan_no: '', aadhaar_no: '',
    });
    const [coBorrowerDocs, setCoBorrowerDocs] = useState<Record<string, { file_url: string; status: string }>>({});
    const [coBorrowerConsentStatus, setCoBorrowerConsentStatus] = useState('awaiting_signature');

    // Other documents
    const [otherDocRequests, setOtherDocRequests] = useState<any[]>([]);
    const [otherDocsStatus, setOtherDocsStatus] = useState('pending');

    // Submission
    const [submitted, setSubmitted] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    // OCR
    const [showOCR, setShowOCR] = useState(false);

    // ─── Load Data ──────────────────────────────────────────────────────────

    useEffect(() => {
        const loadData = async () => {
            try {
                const accessRes = await fetch(`/api/coborrower/${leadId}/access-check`);
                const accessData = await accessRes.json();
                if (!accessData.success || !accessData.allowed) {
                    router.push(`/dealer-portal/leads/${leadId}/kyc`);
                    return;
                }

                setHasCoBorrower(accessData.has_co_borrower ?? null);
                setHasAdditionalDocs(accessData.has_additional_docs ?? false);

                if (accessData.has_co_borrower) {
                    const cobRes = await fetch(`/api/coborrower/${leadId}`);
                    const cobData = await cobRes.json();
                    if (cobData.success && cobData.data) setCoBorrowerForm(cobData.data);

                    const docsRes = await fetch(`/api/coborrower/${leadId}/documents`);
                    const docsData = await docsRes.json();
                    if (docsData.success) {
                        const docMap: Record<string, any> = {};
                        docsData.data.forEach((d: any) => { docMap[d.doc_type] = { file_url: d.file_url, status: d.verification_status }; });
                        setCoBorrowerDocs(docMap);
                    }
                }

                const otherRes = await fetch(`/api/coborrower/${leadId}/required-other-docs`);
                const otherData = await otherRes.json();
                if (otherData.success) setOtherDocRequests(otherData.data || []);
            } catch {
                setApiError('Failed to load data');
            } finally {
                setLoading(false);
            }
        };
        loadData();
    }, [leadId, router]);

    // Auto-save
    useEffect(() => {
        const interval = setInterval(() => handleSaveDraft(true), 120000);
        return () => clearInterval(interval);
    }, [coBorrowerForm, coBorrowerDocs]);

    // ─── Handlers ───────────────────────────────────────────────────────────

    const updateField = (field: string, value: any) => {
        setCoBorrowerForm(prev => {
            const next = { ...prev, [field]: value };
            if (field === 'is_current_same' && value) next.current_address = next.permanent_address;
            if (field === 'permanent_address' && next.is_current_same) next.current_address = value;
            return next;
        });
    };

    const handleDocUpload = async (docType: string, file: File) => {
        if (file.size > 5 * 1024 * 1024) { setApiError('File must be under 5MB'); return; }
        const formData = new FormData();
        formData.append('file', file);
        formData.append('docType', docType);

        try {
            const res = await fetch(`/api/coborrower/${leadId}/upload-document`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                setCoBorrowerDocs(prev => ({ ...prev, [docType]: { file_url: data.file_url, status: 'pending' } }));
            } else {
                setApiError(data.error?.message || 'Upload failed');
            }
        } catch { setApiError('Upload failed'); }
    };

    const handleOtherDocUpload = async (docKey: string, file: File) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('docKey', docKey);
        try {
            const res = await fetch(`/api/coborrower/${leadId}/upload-other-document`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                setOtherDocRequests(prev => prev.map(d => d.doc_key === docKey ? { ...d, file_url: data.file_url, upload_status: 'uploaded' } : d));
            }
        } catch { setApiError('Upload failed'); }
    };

    const handleSendConsent = async (channel: 'sms' | 'whatsapp') => {
        try {
            const res = await fetch(`/api/coborrower/${leadId}/send-consent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel }),
            });
            const data = await res.json();
            if (data.success) setCoBorrowerConsentStatus('link_sent');
        } catch { setApiError('Failed to send consent'); }
    };

    const handleSaveDraft = async (auto = false) => {
        setSaving(true);
        try {
            await fetch(`/api/coborrower/${leadId}/save-draft`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ coBorrowerForm, coBorrowerDocs, coBorrowerConsentStatus, otherDocRequests }),
            });
            setLastSaved(`${auto ? 'Auto-saved' : 'Saved'} at ${new Date().toLocaleTimeString()}`);
        } catch { /* silent */ }
        finally { setSaving(false); }
    };

    const handleSubmitToSM = async () => {
        if (hasCoBorrower) {
            const requiredUploaded = CO_BORROWER_DOCS.filter(d => d.required).every(d => coBorrowerDocs[d.key]?.file_url);
            if (!requiredUploaded) { setApiError('Please upload all required co-borrower documents'); return; }
        }

        setSubmitting(true);
        try {
            const res = await fetch(`/api/leads/${leadId}/submit-to-sm`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setSubmitted(true);
            } else {
                setApiError(data.error?.message || 'Failed to submit');
            }
        } catch { setApiError('Submission failed'); }
        finally { setSubmitting(false); }
    };

    const handleOCRResult = (data: any) => {
        if (data.fullName) updateField('full_name', data.fullName);
        if (data.fatherName) updateField('father_or_husband_name', data.fatherName);
        if (data.dob) updateField('dob', data.dob);
        if (data.address) updateField('permanent_address', data.address);
    };

    // ─── Computed ───────────────────────────────────────────────────────────

    if (loading) return <FullPageLoader />;

    const requiredCobDocs = CO_BORROWER_DOCS.filter(d => d.required);
    const optionalCobDocs = CO_BORROWER_DOCS.filter(d => !d.required);
    const requiredUploaded = requiredCobDocs.filter(d => coBorrowerDocs[d.key]?.file_url).length;
    const optionalUploaded = optionalCobDocs.filter(d => coBorrowerDocs[d.key]?.file_url).length;
    const totalUploaded = requiredUploaded + optionalUploaded;
    const totalDocs = CO_BORROWER_DOCS.length;
    const progressPercent = totalDocs > 0 ? Math.round((totalUploaded / totalDocs) * 100) : 0;

    // Readiness check for summary
    const checks = {
        borrowerKYC: true, // already completed in step 2
        coBorrowerDocs: !hasCoBorrower || requiredUploaded >= requiredCobDocs.length,
        consent: !hasCoBorrower || ['link_sent', 'digitally_signed', 'manual_uploaded', 'admin_verified', 'manual_verified', 'verified'].includes(coBorrowerConsentStatus),
    };
    const allReady = Object.values(checks).every(Boolean);

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <OCRModal open={showOCR} onClose={() => setShowOCR(false)} onResult={handleOCRResult} />

            <div className="max-w-[1200px] mx-auto px-6 py-8 pb-40">
                <ProgressHeader
                    title="Co-Borrower KYC"
                    subtitle={`Lead: ${leadId}`}
                    step={3}
                    onBack={() => router.back()}
                />

                <ErrorBanner message={apiError} onDismiss={() => setApiError(null)} />

                {/* ─── Submitted Success ──────────────────────────── */}
                {submitted && (
                    <motion.div initial={fadeSlideInitial} animate={fadeSlideAnimate} exit={fadeSlideExit} transition={fadeSlideTransition} className="mb-8">
                        <div className="p-10 bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-[28px] text-center">
                            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                                <CheckCircle2 className="w-10 h-10 text-green-600" />
                            </div>
                            <h2 className="text-2xl font-black text-green-900">Submitted to iTarang Team</h2>
                            <p className="text-sm text-green-700 mt-2 max-w-md mx-auto">
                                Your application has been sent to <strong>sales.head@itarang.com</strong> for review.
                                Our sales team will review all documents and get back to you with financing options.
                            </p>
                            <div className="mt-6 flex justify-center gap-4">
                                <button onClick={() => router.push('/dealer-portal/leads')} className="px-8 py-3 bg-[#0047AB] text-white rounded-xl font-bold text-sm hover:bg-[#003580] transition-all">
                                    Back to Leads
                                </button>
                                <button onClick={() => router.push(`/dealer-portal/leads/${leadId}/options`)} className="px-8 py-3 border-2 border-[#0047AB] text-[#0047AB] rounded-xl font-bold text-sm hover:bg-blue-50 transition-all flex items-center gap-2">
                                    View Loan Options <ArrowRight className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}

                {!submitted && (
                    <main className="grid grid-cols-1 gap-6">
                        {/* ─── Co-Borrower Toggle ────────────────────── */}
                        <SectionCard title="Co-Borrower Required?">
                            <p className="text-sm text-gray-500 mb-5">Does this application have a co-borrower or guarantor?</p>
                            <div className="grid grid-cols-2 gap-4 max-w-md">
                                <button
                                    onClick={() => setHasCoBorrower(true)}
                                    className={`relative flex flex-col items-center gap-3 p-6 rounded-2xl border-2 transition-all duration-200 ${
                                        hasCoBorrower === true
                                            ? 'border-[#0047AB] bg-blue-50 shadow-[0_0_0_4px_rgba(0,71,171,0.1)]'
                                            : 'border-gray-200 hover:border-gray-300 bg-white'
                                    }`}
                                >
                                    <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                                        hasCoBorrower === true ? 'bg-[#0047AB] text-white' : 'bg-gray-100 text-gray-400'
                                    }`}>
                                        <User className="w-6 h-6" />
                                    </div>
                                    <span className="font-bold text-sm text-gray-900">Yes, add co-borrower</span>
                                    {hasCoBorrower === true && (
                                        <div className="absolute top-3 right-3 w-5 h-5 bg-[#0047AB] rounded-full flex items-center justify-center">
                                            <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                                        </div>
                                    )}
                                </button>

                                <button
                                    onClick={() => setHasCoBorrower(false)}
                                    className={`relative flex flex-col items-center gap-3 p-6 rounded-2xl border-2 transition-all duration-200 ${
                                        hasCoBorrower === false
                                            ? 'border-gray-400 bg-gray-50 shadow-[0_0_0_4px_rgba(0,0,0,0.05)]'
                                            : 'border-gray-200 hover:border-gray-300 bg-white'
                                    }`}
                                >
                                    <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                                        hasCoBorrower === false ? 'bg-gray-600 text-white' : 'bg-gray-100 text-gray-400'
                                    }`}>
                                        <UserX className="w-6 h-6" />
                                    </div>
                                    <span className="font-bold text-sm text-gray-900">No co-borrower</span>
                                    {hasCoBorrower === false && (
                                        <div className="absolute top-3 right-3 w-5 h-5 bg-gray-600 rounded-full flex items-center justify-center">
                                            <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                                        </div>
                                    )}
                                </button>
                            </div>
                            {hasCoBorrower === false && (
                                <p className="text-xs text-gray-400 mt-4">Skip co-borrower — you can submit the application directly below.</p>
                            )}
                        </SectionCard>

                        {/* ─── Co-Borrower Sections (animated) ───────── */}
                        <AnimatePresence mode="wait">
                            {hasCoBorrower && (
                                <motion.div initial={fadeSlideInitial} animate={fadeSlideAnimate} exit={fadeSlideExit} transition={fadeSlideTransition} className="grid grid-cols-1 gap-6">
                                    {/* Co-Borrower Details */}
                                    <SectionCard
                                        title="Co-Borrower Details"
                                        action={
                                            <button onClick={() => setShowOCR(true)} className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-bold hover:border-[#1D4ED8] transition-all">
                                                <Scan className="w-4 h-4" /> Auto-fill from Aadhaar
                                            </button>
                                        }
                                    >
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                                            <InputField label="Full Name" value={coBorrowerForm.full_name} onChange={v => updateField('full_name', v)} placeholder="John Doe" required />
                                            <InputField label="Father/Husband Name" value={coBorrowerForm.father_or_husband_name} onChange={v => updateField('father_or_husband_name', v)} placeholder="Richard Doe" required />
                                            <InputField label="Date of Birth" type="date" value={coBorrowerForm.dob} onChange={v => updateField('dob', v)} required />
                                            <InputField label="Phone" value={coBorrowerForm.phone} onChange={v => updateField('phone', v)} placeholder="+91 9876543210" required />
                                            <InputField label="PAN Number" value={coBorrowerForm.pan_no} onChange={v => updateField('pan_no', v.toUpperCase())} placeholder="ABCDE1234F" />
                                            <InputField label="Aadhaar Number" value={coBorrowerForm.aadhaar_no} onChange={v => updateField('aadhaar_no', v)} placeholder="1234 5678 9012" />
                                            <div className="md:col-span-2">
                                                <InputField label="Permanent Address" value={coBorrowerForm.permanent_address} onChange={v => updateField('permanent_address', v)} placeholder="Full address" />
                                            </div>
                                            <div className="md:col-span-2 space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <label className="text-sm font-bold text-gray-900 px-1">Current Address</label>
                                                    <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-gray-600">
                                                        <input type="checkbox" checked={coBorrowerForm.is_current_same} onChange={e => updateField('is_current_same', e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-[#0047AB]" />
                                                        Same as permanent
                                                    </label>
                                                </div>
                                                <input
                                                    value={coBorrowerForm.current_address}
                                                    disabled={coBorrowerForm.is_current_same}
                                                    onChange={e => updateField('current_address', e.target.value)}
                                                    className={`w-full h-11 px-4 bg-white border-2 rounded-xl outline-none text-sm transition-all ${
                                                        coBorrowerForm.is_current_same ? 'bg-gray-50 border-gray-100 text-gray-400' : 'border-[#EBEBEB] focus:border-[#1D4ED8]'
                                                    }`}
                                                    placeholder="Current address"
                                                />
                                            </div>
                                        </div>
                                    </SectionCard>

                                    {/* Co-Borrower Documents */}
                                    <SectionCard title="Co-Borrower Documents">
                                        {/* Progress summary */}
                                        <div className="bg-gradient-to-r from-[#F8FAFF] to-[#F0F4FF] rounded-2xl p-5 mb-6 border border-blue-100">
                                            <div className="flex items-center justify-between mb-3">
                                                <div className="flex items-center gap-6 text-sm">
                                                    <span className="font-bold text-gray-900">
                                                        <span className="text-green-600">{requiredUploaded}/{requiredCobDocs.length}</span> Required
                                                    </span>
                                                    <span className="font-bold text-gray-900">
                                                        <span className="text-blue-600">{optionalUploaded}/{optionalCobDocs.length}</span> Optional
                                                    </span>
                                                    <span className="font-bold text-gray-500">
                                                        Total: {totalUploaded}/{totalDocs}
                                                    </span>
                                                </div>
                                                <span className="text-sm font-black text-[#0047AB]">{progressPercent}%</span>
                                            </div>
                                            <div className="h-2.5 bg-white rounded-full overflow-hidden border border-blue-100">
                                                <motion.div
                                                    className="h-full bg-gradient-to-r from-[#0047AB] to-[#1D4ED8] rounded-full"
                                                    initial={{ width: 0 }}
                                                    animate={{ width: `${progressPercent}%` }}
                                                    transition={{ duration: 0.6, ease: 'easeOut' }}
                                                />
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                                            {CO_BORROWER_DOCS.map(doc => (
                                                <DocumentCard
                                                    key={doc.key}
                                                    label={doc.label}
                                                    required={doc.required}
                                                    uploaded={!!coBorrowerDocs[doc.key]?.file_url}
                                                    status={coBorrowerDocs[doc.key]?.status}
                                                    onUpload={file => handleDocUpload(doc.key, file)}
                                                />
                                            ))}
                                        </div>
                                    </SectionCard>

                                    {/* Co-Borrower Consent */}
                                    <SectionCard title="Co-Borrower Consent">
                                        <p className="text-sm text-gray-500 mb-4">Send consent link for digital signature verification</p>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                            <button
                                                onClick={() => handleSendConsent('sms')}
                                                disabled={coBorrowerConsentStatus !== 'awaiting_signature'}
                                                className="flex items-center justify-center gap-2 px-4 py-3 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 hover:bg-[#003580] transition-all"
                                            >
                                                <Send className="w-4 h-4" /> Send via SMS
                                            </button>
                                            <button
                                                onClick={() => handleSendConsent('whatsapp')}
                                                disabled={coBorrowerConsentStatus !== 'awaiting_signature'}
                                                className="flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-xl text-sm font-bold disabled:opacity-40 hover:bg-green-700 transition-all"
                                            >
                                                <Send className="w-4 h-4" /> Send via WhatsApp
                                            </button>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm text-gray-500">Status:</span>
                                            <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                                                coBorrowerConsentStatus === 'awaiting_signature' ? 'bg-gray-100 text-gray-600' :
                                                ['digitally_signed', 'manual_uploaded', 'admin_verified', 'manual_verified', 'verified'].includes(coBorrowerConsentStatus) ? 'bg-green-50 text-green-700' :
                                                'bg-amber-50 text-amber-700'
                                            }`}>
                                                <div className={`w-1.5 h-1.5 rounded-full ${
                                                    coBorrowerConsentStatus === 'awaiting_signature' ? 'bg-gray-400' :
                                                    ['digitally_signed', 'manual_uploaded', 'admin_verified', 'manual_verified', 'verified'].includes(coBorrowerConsentStatus) ? 'bg-green-500' :
                                                    'bg-amber-500'
                                                }`} />
                                                {coBorrowerConsentStatus.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                            </div>
                                        </div>
                                    </SectionCard>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* ─── Additional Documents ──────────────────── */}
                        {otherDocRequests.length > 0 && (
                            <SectionCard title="Additional Documents (Requested by iTarang)">
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                                    {otherDocRequests.map((doc: any) => (
                                        <DocumentCard
                                            key={doc.doc_key}
                                            label={doc.doc_label}
                                            required={doc.is_required}
                                            uploaded={doc.upload_status === 'uploaded' || doc.upload_status === 'verified'}
                                            status={doc.upload_status === 'verified' ? 'success' : doc.upload_status === 'rejected' ? 'failed' : 'pending'}
                                            failedReason={doc.rejection_reason}
                                            onUpload={file => handleOtherDocUpload(doc.doc_key, file)}
                                        />
                                    ))}
                                </div>
                                {otherDocsStatus === 'pending_review' ? (
                                    <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-xs font-medium text-amber-700">
                                        Documents submitted for review.
                                    </div>
                                ) : (
                                    <button
                                        onClick={async () => {
                                            const allUploaded = otherDocRequests.filter(d => d.is_required).every(d => d.upload_status === 'uploaded');
                                            if (!allUploaded) { setApiError('Please upload all required documents'); return; }
                                            try {
                                                const res = await fetch(`/api/coborrower/${leadId}/submit-other-docs-review`, { method: 'POST' });
                                                const data = await res.json();
                                                if (data.success) setOtherDocsStatus('pending_review');
                                            } catch { setApiError('Submission failed'); }
                                        }}
                                        className="px-6 py-3 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all"
                                    >
                                        Submit Documents for Review
                                    </button>
                                )}
                            </SectionCard>
                        )}

                        {/* ─── Application Summary & Submit ──────────── */}
                        {hasCoBorrower !== null && (
                            <div className="bg-gradient-to-br from-white to-[#FAFBFF] rounded-[24px] border border-[#E9ECEF] shadow-[0_8px_30px_rgb(0,0,0,0.02)] overflow-hidden">
                                <div className="px-8 pt-8 pb-4 flex items-center gap-4">
                                    <div className="w-[3px] h-6 bg-[#0047AB] rounded-full" />
                                    <h3 className="text-lg font-black text-gray-900 tracking-tight flex items-center gap-2">
                                        <Sparkles className="w-5 h-5 text-[#0047AB]" /> Submit Application
                                    </h3>
                                </div>
                                <div className="px-8 pb-8 pt-2">
                                    <div className="bg-[#F8FAFF] rounded-2xl p-6 border border-blue-100 mb-6">
                                        <p className="text-sm font-bold text-gray-900 mb-4">Application Readiness</p>
                                        <div className="space-y-3">
                                            <ReadinessItem label="Borrower KYC" done={checks.borrowerKYC} detail="Completed in Step 2" />
                                            <ReadinessItem
                                                label="Co-Borrower Documents"
                                                done={checks.coBorrowerDocs}
                                                detail={hasCoBorrower ? `${requiredUploaded}/${requiredCobDocs.length} required docs uploaded` : 'No co-borrower — not required'}
                                            />
                                            <ReadinessItem
                                                label="Consent"
                                                done={checks.consent}
                                                detail={hasCoBorrower ? coBorrowerConsentStatus.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Not required'}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-3 px-4 py-3 bg-blue-50 rounded-xl border border-blue-100 mb-6">
                                        <FileText className="w-5 h-5 text-[#0047AB] flex-shrink-0" />
                                        <p className="text-xs text-gray-600">
                                            Submitting sends this application to <strong>iTarang Sales Team</strong> (sales.head@itarang.com) for review.
                                            You will be notified once loan options are ready.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </main>
                )}

                {/* ─── Bottom Bar ──────────────────────────────────── */}
                {!submitted && (
                    <StickyBottomBar lastSaved={lastSaved}>
                        <OutlineButton onClick={() => router.back()}>Back</OutlineButton>
                        <SecondaryButton onClick={() => handleSaveDraft(false)} loading={saving}>Save Draft</SecondaryButton>
                        <PrimaryButton onClick={handleSubmitToSM} loading={submitting} disabled={submitting || hasCoBorrower === null}>
                            Submit to Itarang Team <ChevronRight className="w-4 h-4" />
                        </PrimaryButton>
                    </StickyBottomBar>
                )}
            </div>
        </div>
    );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ReadinessItem({ label, done, detail }: { label: string; done: boolean; detail: string }) {
    return (
        <div className="flex items-center gap-3">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                done ? 'bg-green-100' : 'bg-gray-100'
            }`}>
                {done ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                ) : (
                    <Clock className="w-4 h-4 text-gray-400" />
                )}
            </div>
            <div className="flex-1">
                <span className="text-sm font-bold text-gray-900">{label}</span>
                <span className="text-xs text-gray-500 ml-2">{detail}</span>
            </div>
        </div>
    );
}
