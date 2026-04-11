'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Clock,
    Download, Eye, Loader2, RefreshCw, Send, Shield, Upload, X, FileText,
} from 'lucide-react';
import {
    SectionCard, DocumentCard, StatusBadge, ProgressHeader,
    StickyBottomBar, ErrorBanner, PrimaryButton, SecondaryButton,
    OutlineButton, FullPageLoader,
} from '@/components/dealer-portal/lead-wizard/shared';
import { FINANCE_DOCUMENTS } from '@/components/dealer-portal/lead-wizard/constants';

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

type VerificationRow = {
    type: string;
    label: string;
    status: string;
    last_update?: string | null;
    failed_reason?: string | null;
};

function isFinalConsentStatus(status: string) {
    return ['admin_verified', 'manual_verified', 'verified'].includes((status || '').toLowerCase());
}

function ConsentStatusBadge({ status }: { status: string }) {
    const s = (status || '').toLowerCase();
    if (isFinalConsentStatus(s)) {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Verified</span>;
    }
    if (s === 'admin_review_pending') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold"><Clock className="w-3 h-3" />Pending Review</span>;
    }
    if (s === 'admin_rejected') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold"><AlertCircle className="w-3 h-3" />Rejected</span>;
    }
    if (s === 'esign_failed') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold"><AlertCircle className="w-3 h-3" />eSign Failed</span>;
    }
    if (s === 'esign_blocked') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold"><AlertCircle className="w-3 h-3" />Blocked</span>;
    }
    if (s === 'expired') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold"><Clock className="w-3 h-3" />Expired</span>;
    }
    if (s === 'esign_completed') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Customer Signed</span>;
    }
    if (s === 'esign_in_progress') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Loader2 className="w-3 h-3 animate-spin" />Signing in Progress</span>;
    }
    if (s === 'link_sent' || s === 'link_opened') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Send className="w-3 h-3" />{s === 'link_opened' ? 'Link Opened' : 'Link Sent'}</span>;
    }
    if (s === 'consent_generated') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-teal-100 text-teal-700 rounded-full text-xs font-bold"><FileText className="w-3 h-3" />PDF Generated</span>;
    }
    if (s === 'consent_uploaded') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Upload className="w-3 h-3" />Uploaded</span>;
    }
    return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-bold">Awaiting Signature</span>;
}

export default function KYCPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;

    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [lead, setLead] = useState<any>(null);
    const [accessDenied, setAccessDenied] = useState(false);
    const [apiError, setApiError] = useState<string | null>(null);

    const [uploadedDocs, setUploadedDocs] = useState<Record<string, UploadedDoc>>({});
    const [verifications, setVerifications] = useState<VerificationRow[]>([]);
    const [consentStatus, setConsentStatus] = useState<string>('awaiting_signature');

    const [savingDraft, setSavingDraft] = useState(false);
    const [lastSaved, setLastSaved] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Consent flow state
    const [consentPath, setConsentPath] = useState<'none' | 'digital' | 'manual'>('none'); // mutually exclusive
    const [consentLoading, setConsentLoading] = useState(false);
    const [consentPdfUrl, setConsentPdfUrl] = useState<string | null>(null);

    // Consent record details
    const [consentRecord, setConsentRecord] = useState<any>(null);

    // Coupon state
    const [couponCode, setCouponCode] = useState('');
    const [couponValidating, setCouponValidating] = useState(false);
    const [couponResult, setCouponResult] = useState<any>(null);
    const [releasingCoupon, setReleasingCoupon] = useState(false);
    const [submittedForVerification, setSubmittedForVerification] = useState(false);

    // ─── Data Loading ───────────────────────────────────────────────────────

    const loadPageData = async (soft = false) => {
        if (soft) setRefreshing(true);
        else setLoading(true);

        try {
            setApiError(null);
            const accessRes = await fetch(`/api/kyc/${leadId}/access-check`, { cache: 'no-store' });
            const accessJson = await accessRes.json();

            const canAccess = accessJson?.data?.canAccess ?? accessJson?.allowed ?? false;
            const fetchedLead = accessJson?.data?.lead ?? accessJson?.lead ?? null;

            if (!canAccess) {
                setAccessDenied(true);
                setLead(fetchedLead);
                return;
            }

            setAccessDenied(false);
            setLead(fetchedLead);
            if (fetchedLead?.consent_status) setConsentStatus(fetchedLead.consent_status);

            // Restore coupon state from lead
            if (fetchedLead?.coupon_code && fetchedLead?.coupon_status === 'reserved') {
                setCouponCode(fetchedLead.coupon_code);
                setCouponResult({ valid: true, success: true, coupon_code: fetchedLead.coupon_code, status: 'reserved', message: 'Coupon reserved' });
            } else if (fetchedLead?.coupon_code && fetchedLead?.coupon_status === 'used') {
                setCouponCode(fetchedLead.coupon_code);
                setCouponResult({ valid: true, success: true, coupon_code: fetchedLead.coupon_code, status: 'used', message: 'Coupon used' });
                setSubmittedForVerification(true);
            }

            const [docsRes, verificationsRes, consentRes] = await Promise.allSettled([
                fetch(`/api/kyc/${leadId}/documents`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/verifications?verification_for=customer`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/consent/status?consent_for=customer`, { cache: 'no-store' }),
            ]);

            if (docsRes.status === 'fulfilled') {
                const docsJson = await docsRes.value.json();
                if (docsJson?.success && Array.isArray(docsJson.data)) {
                    const mapped: Record<string, UploadedDoc> = {};
                    for (const doc of docsJson.data) mapped[doc.doc_type] = doc;
                    setUploadedDocs(mapped);
                }
            }

            if (verificationsRes.status === 'fulfilled') {
                const verJson = await verificationsRes.value.json();
                if (verJson?.success && Array.isArray(verJson.data)) setVerifications(verJson.data);
            }

            if (consentRes.status === 'fulfilled') {
                const consentJson = await consentRes.value.json();
                if (consentJson?.success && consentJson.data) {
                    setConsentRecord(consentJson.data);
                    // Sync consent status from record (most up-to-date source)
                    if (consentJson.data.consent_status) setConsentStatus(consentJson.data.consent_status);
                }
            }
        } catch {
            setApiError('Failed to load KYC data');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => { loadPageData(); }, [leadId]);

    // Auto-poll consent status when waiting for customer action
    useEffect(() => {
        const waitingStatuses = ['link_sent', 'link_opened', 'esign_in_progress'];
        if (!waitingStatuses.includes(consentStatus)) return;
        const interval = setInterval(() => loadPageData(true), 10000); // poll every 10s
        return () => clearInterval(interval);
    }, [consentStatus, leadId]);

    // Auto-save every 2 minutes
    useEffect(() => {
        const interval = setInterval(() => {
            if (!loading && !accessDenied && Object.keys(uploadedDocs).length > 0) handleSaveDraft(true);
        }, 120000);
        return () => clearInterval(interval);
    }, [loading, accessDenied, uploadedDocs, consentStatus]);

    // ─── Document Stats ─────────────────────────────────────────────────────

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

    // ─── Document Upload ────────────────────────────────────────────────────

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

            const res = await fetch(`/api/kyc/${leadId}/upload-document`, { method: 'POST', body: formData });
            const data = await res.json();

            if (!res.ok || !data?.success) throw new Error(data?.message || data?.error?.message || 'Upload failed');

            setUploadedDocs(prev => ({
                ...prev,
                [documentType]: {
                    ...(prev[documentType] || {}),
                    doc_type: documentType,
                    verification_status: 'pending',
                    doc_status: 'uploaded',
                    file_url: data?.fileUrl || prev[documentType]?.file_url || null,
                    file_name: file.name,
                    file_size: file.size,
                    uploaded_at: new Date().toISOString(),
                },
            }));
            await loadPageData(true);
        } catch (err: any) {
            setApiError(err?.message || 'Document upload failed');
        }
    };

    // ─── Save Draft ─────────────────────────────────────────────────────────

    const handleSaveDraft = async (auto = false) => {
        try {
            setSavingDraft(true);
            const res = await fetch(`/api/kyc/${leadId}/save-draft`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ step: 2, data: { documents: uploadedDocs, consentStatus } }),
            });
            if (!res.ok) throw new Error('Failed to save draft');
            setLastSaved(`${auto ? 'Auto-saved' : 'Saved'} at ${new Date().toLocaleTimeString()}`);
        } catch (err: any) {
            setApiError(err?.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    // ─── Consent ────────────────────────────────────────────────────────────

    const handleSendConsent = async (channel: 'sms' | 'whatsapp') => {
        try {
            setApiError(null);
            setConsentLoading(true);
            setConsentPath('digital');
            const res = await fetch(`/api/kyc/${leadId}/send-consent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel, consent_for: 'customer' }),
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
                body: JSON.stringify({ consent_for: 'customer' }),
            });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.error?.message || data?.message || 'Failed to generate consent PDF');
            setConsentStatus('consent_generated');
            setConsentPdfUrl(data.pdfUrl || null);
            // Auto-download PDF locally
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
            formData.append('consent_for', 'customer');
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

    // Determine which consent path is active based on status
    useEffect(() => {
        const digitalStatuses = ['link_sent', 'link_opened', 'esign_in_progress', 'esign_completed'];
        const manualStatuses = ['consent_generated', 'consent_uploaded'];
        if (digitalStatuses.includes(consentStatus)) setConsentPath('digital');
        else if (manualStatuses.includes(consentStatus)) setConsentPath('manual');
        else if (isFinalConsentStatus(consentStatus) || consentStatus === 'admin_review_pending' || consentStatus === 'admin_rejected') {
            // Keep whatever path was set, or detect from status
        }
    }, [consentStatus]);

    // ─── Coupon Validation ──────────────────────────────────────────────────

    const handleValidateCoupon = async () => {
        if (!couponCode.trim()) { setApiError('Please enter coupon code'); return; }
        setCouponValidating(true);
        setCouponResult(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/validate-coupon`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ couponCode: couponCode.trim() }),
            });
            const data = await res.json();
            setCouponResult(data);
            if (data.success || data.valid) {
                if (data.already_used) {
                    // Repeat validation — show inline message, no alert
                    setLead((prev: any) => prev ? { ...prev, coupon_code: data.coupon_code, coupon_status: data.status } : prev);
                } else {
                    // First validation — show success alert
                    setLead((prev: any) => prev ? { ...prev, coupon_code: data.coupon_code, coupon_status: 'reserved' } : prev);
                    alert(`Coupon "${data.coupon_code}" validated successfully! Your coupon has been reserved for this lead.`);
                }
            } else {
                setApiError(data.message || data.error || 'Invalid coupon');
            }
        } catch {
            setApiError('Coupon validation failed');
        } finally {
            setCouponValidating(false);
        }
    };

    const handleReleaseCoupon = async () => {
        setReleasingCoupon(true);
        setApiError(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/release-coupon`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setCouponCode('');
                setCouponResult(null);
            } else {
                setApiError(data.error?.message || 'Failed to release coupon');
            }
        } catch {
            setApiError('Failed to release coupon');
        } finally {
            setReleasingCoupon(false);
        }
    };

    const handleSubmitForVerification = async () => {
        try {
            setApiError(null);
            setSubmitting(true);
            const res = await fetch(`/api/kyc/${leadId}/submit-verification`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ verification_for: 'customer' }),
            });
            const data = await res.json();
            if (data.success) {
                setSubmittedForVerification(true);
                setLead((prev: any) => prev ? { ...prev, coupon_status: 'used' } : prev);
                alert('Verification submitted successfully! KYC verification is now in progress.');
                await loadPageData(true);
            } else {
                setApiError(data.message || data.error?.message || 'Submission failed');
            }
        } catch {
            setApiError('Failed to submit for verification');
        } finally {
            setSubmitting(false);
        }
    };

    // ─── Save & Next ────────────────────────────────────────────────────────

    const handleSaveAndNext = async () => {
        try {
            setSubmitting(true);
            setApiError(null);
            router.push(`/dealer-portal/leads/${leadId}/borrower-consent`);
        } catch (err: any) {
            setApiError(err?.message || 'Failed to proceed');
        } finally {
            setSubmitting(false);
        }
    };

    // ─── Render ─────────────────────────────────────────────────────────────

    if (loading) return <FullPageLoader />;

    if (accessDenied) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
                <div className="text-center max-w-md">
                    <Shield className="w-14 h-14 text-red-400 mx-auto mb-4" />
                    <h2 className="text-2xl font-bold text-gray-900">Access Denied</h2>
                    <p className="mt-2 text-sm text-gray-500">Step 2 is only available for hot leads with non-cash payment method.</p>
                    <button onClick={() => router.push('/dealer-portal/leads')} className="mt-6 px-6 py-3 bg-[#0047AB] text-white rounded-xl font-bold">Back to Leads</button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1200px] mx-auto px-6 py-8 pb-40">
                {/* Header */}
                <ProgressHeader
                    title="KYC"
                    subtitle={`Reference ID: ${lead?.reference_id || leadId}${lead?.full_name ? ` — ${lead.full_name}` : ''}`}
                    step={2}
                    onBack={() => router.back()}
                    rightAction={
                        <button onClick={() => loadPageData(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold">
                            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
                        </button>
                    }
                />

                <ErrorBanner message={apiError} onDismiss={() => setApiError(null)} />

                <main className="grid grid-cols-1 gap-6">
                    {/* ─── Customer Consent ───────────────────────────── */}
                    <SectionCard title="Customer Consent" action={
                        <ConsentStatusBadge status={consentStatus} />
                    }>
                        {isFinalConsentStatus(consentStatus) ? (
                            /* ── Consent Verified ─────────────────────────── */
                            <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                                <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                                <div>
                                    <p className="text-sm font-bold text-emerald-800">Consent Verified</p>
                                    <p className="text-xs text-emerald-600 mt-0.5">Admin has verified the customer consent. You can proceed to the next step.</p>
                                </div>
                            </div>
                        ) : consentStatus === 'admin_review_pending' ? (
                            /* ── Awaiting Admin Review ────────────────────── */
                            <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                                <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                                <div>
                                    <p className="text-sm font-bold text-amber-800">Awaiting Admin Verification</p>
                                    <p className="text-xs text-amber-600 mt-0.5">Signed consent has been uploaded and is pending admin review. You will be notified once verified.</p>
                                </div>
                            </div>
                        ) : consentStatus === 'esign_failed' ? (
                            /* ── eSign Failed — Retry ─────────────────────── */
                            <div className="space-y-4">
                                <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
                                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-bold text-red-800">Aadhaar eSign Failed</p>
                                        <p className="text-xs text-red-600 mt-0.5">Customer eSign was unsuccessful. You can resend the consent link or switch to manual consent.</p>
                                    </div>
                                </div>
                                <div className="flex gap-3">
                                    <button onClick={() => handleSendConsent('whatsapp')} disabled={consentLoading}
                                        className="px-5 py-2.5 bg-[#25D366] text-white rounded-xl text-sm font-bold hover:bg-[#1da851] transition-all disabled:opacity-50 flex items-center gap-2">
                                        {consentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Resend via WhatsApp
                                    </button>
                                    <button onClick={handleGenerateConsentPDF} disabled={consentLoading}
                                        className="px-5 py-2.5 bg-white border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-50 flex items-center gap-2">
                                        <FileText className="w-4 h-4" /> Switch to Manual
                                    </button>
                                </div>
                            </div>
                        ) : consentStatus === 'esign_blocked' ? (
                            /* ── eSign Blocked — Must use manual ──────────── */
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
                            /* ── Link Expired — Resend ────────────────────── */
                            <div className="space-y-4">
                                <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                                    <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-bold text-amber-800">Consent Link Expired</p>
                                        <p className="text-xs text-amber-600 mt-0.5">The consent link has expired (24 hours). Please resend.</p>
                                    </div>
                                </div>
                                <div className="flex gap-3">
                                    <button onClick={() => handleSendConsent('whatsapp')} disabled={consentLoading}
                                        className="px-5 py-2.5 bg-[#25D366] text-white rounded-xl text-sm font-bold hover:bg-[#1da851] transition-all disabled:opacity-50 flex items-center gap-2">
                                        {consentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Resend via WhatsApp
                                    </button>
                                    <button onClick={() => handleSendConsent('sms')} disabled={consentLoading}
                                        className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center gap-2">
                                        {consentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Resend via SMS
                                    </button>
                                </div>
                            </div>
                        ) : consentStatus === 'esign_completed' ? (
                            /* ── Customer Signed Successfully ────────────── */
                            <div className="space-y-3">
                                <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                                    <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                                        <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-emerald-800">Customer Signed Successfully</p>
                                        <p className="text-xs text-emerald-600 mt-0.5">The customer has completed Aadhaar eSign. Consent is now pending admin verification.</p>
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
                            /* ── eSign In Progress ───────────────────────── */
                            <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                                    <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
                                </div>
                                <div className="flex-1">
                                    <p className="text-sm font-bold text-blue-800">Customer is Signing...</p>
                                    <p className="text-xs text-blue-600 mt-0.5">Customer has opened the consent link and is completing the Aadhaar eSign process. This page will update automatically.</p>
                                </div>
                            </div>
                        ) : consentStatus === 'admin_rejected' ? (
                            /* ── Rejected — Re-consent ────────────────────── */
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
                                <div className="flex gap-3">
                                    <button onClick={() => handleSendConsent('whatsapp')} disabled={consentLoading}
                                        className="px-5 py-2.5 bg-[#25D366] text-white rounded-xl text-sm font-bold hover:bg-[#1da851] transition-all disabled:opacity-50 flex items-center gap-2">
                                        {consentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Resend Digital
                                    </button>
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
                                <p className="text-sm text-gray-500">Choose one method to obtain customer consent. Both options are mutually exclusive.</p>

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
                                                <p className="text-xs text-gray-500 mt-0.5">Send consent link via SMS/WhatsApp. Customer signs digitally with Aadhaar OTP.</p>
                                            </div>
                                        </div>
                                        {consentPath !== 'manual' && (
                                            <div className="flex gap-2">
                                                <button onClick={() => handleSendConsent('whatsapp')} disabled={consentLoading || consentPath === 'digital'}
                                                    className="flex-1 px-3 py-2 bg-[#25D366] text-white rounded-lg text-xs font-bold hover:bg-[#1da851] transition-all disabled:opacity-50 flex items-center justify-center gap-1.5">
                                                    {consentLoading && consentPath === 'digital' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                                    WhatsApp
                                                </button>
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
                                                    {consentStatus === 'link_opened' ? 'Customer opened the link. Waiting for signature...' : 'Consent link sent. Waiting for customer to sign...'}
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
                                                <p className="text-xs text-gray-500 mt-0.5">Generate PDF, print, get customer signature, scan and upload.</p>
                                            </div>
                                        </div>
                                        {consentPath !== 'digital' && (
                                            <div className="space-y-2">
                                                {/* Step 1: Generate PDF */}
                                                <button onClick={handleGenerateConsentPDF}
                                                    disabled={consentLoading || consentStatus === 'consent_generated' || consentStatus === 'consent_uploaded'}
                                                    className="w-full px-3 py-2 bg-teal-600 text-white rounded-lg text-xs font-bold hover:bg-teal-700 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5">
                                                    {consentLoading && consentPath === 'manual' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                                                    {consentStatus === 'consent_generated' ? 'PDF Generated' : 'Generate Consent PDF'}
                                                </button>

                                                {/* Step 2: Upload Signed PDF (enabled after generate) */}
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

                    {/* ─── Loan Documents ─────────────────────────────── */}
                    <SectionCard title="Loan Documents" action={
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

                    {/* ─── Verification Action ────────────────────────── */}
                    <SectionCard title="Verification Action" action={
                        lead?.coupon_status === 'used'
                            ? <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Submitted</span>
                            : lead?.coupon_status === 'reserved'
                                ? <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Shield className="w-3 h-3" />Reserved</span>
                                : <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-bold">Awaiting Coupon</span>
                    }>
                        {lead?.coupon_status === 'used' || submittedForVerification ? (
                            /* ── Coupon Used / Verification Submitted ──── */
                            <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                                <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                                <div>
                                    <p className="text-sm font-bold text-emerald-800">Verification Submitted</p>
                                    <p className="text-xs text-emerald-600 mt-0.5">Coupon <span className="font-mono font-bold">{couponCode}</span> consumed. Verification is in progress.</p>
                                </div>
                            </div>
                        ) : (couponResult?.valid || couponResult?.success) && lead?.coupon_status === 'reserved' ? (
                            /* ── Coupon Reserved ──────────────────────── */
                            <div className="space-y-3">
                                <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                                    <Shield className="w-5 h-5 text-blue-600 flex-shrink-0" />
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-blue-800">
                                            Coupon Reserved: <span className="font-mono">{couponCode}</span>
                                        </p>
                                        {couponResult.discount_amount > 0 && (
                                            <p className="text-xs text-blue-600 mt-0.5">Discount: ₹{couponResult.discount_amount} off (Final: ₹{couponResult.final_amount})</p>
                                        )}
                                        <p className="text-xs text-blue-500 mt-0.5">This coupon is locked to this lead. Click Submit to start verification.</p>
                                    </div>
                                    <button
                                        onClick={handleReleaseCoupon}
                                        disabled={releasingCoupon}
                                        className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-xs font-bold text-gray-600 hover:bg-gray-50 transition-all disabled:opacity-50 flex items-center gap-1.5"
                                    >
                                        {releasingCoupon ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                        Change Coupon
                                    </button>
                                </div>
                                <button
                                    onClick={handleSubmitForVerification}
                                    disabled={submitting}
                                    className="w-full px-6 py-3 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                                    Submit for Verification
                                </button>
                            </div>
                        ) : (
                            /* ── Enter Coupon Code ────────────────────── */
                            <div className="space-y-3">
                                <p className="text-xs text-gray-500">Enter your verification coupon code to proceed. Each coupon allows one KYC verification.</p>
                                <div className="flex items-center gap-3">
                                    <input
                                        type="text"
                                        value={couponCode}
                                        onChange={e => setCouponCode(e.target.value.toUpperCase())}
                                        placeholder="Enter coupon code (e.g., ITARANG-FREE)"
                                        maxLength={20}
                                        className="flex-1 h-11 px-4 bg-white border-2 border-[#EBEBEB] rounded-xl outline-none text-sm font-mono focus:border-[#1D4ED8] transition-all"
                                    />
                                    <button
                                        onClick={handleValidateCoupon}
                                        disabled={couponValidating || !couponCode.trim()}
                                        className="px-6 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center gap-2"
                                    >
                                        {couponValidating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                                        Validate
                                    </button>
                                </div>
                                {couponResult && couponResult.already_used && (
                                    <div className="px-4 py-2 bg-amber-50 border border-amber-200 rounded-xl">
                                        <p className="text-sm font-medium text-amber-700">
                                            <AlertCircle className="w-4 h-4 inline mr-1" />
                                            Coupon <span className="font-mono font-bold">{couponResult.coupon_code}</span> is already applied to this lead.
                                        </p>
                                    </div>
                                )}
                                {couponResult && !couponResult.valid && !couponResult.success && (
                                    <div className="px-4 py-2 bg-red-50 border border-red-200 rounded-xl">
                                        <p className="text-sm font-medium text-red-700">
                                            <AlertCircle className="w-4 h-4 inline mr-1" />
                                            {couponResult.message || 'Invalid coupon code'}
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </SectionCard>

                    {/* ─── Verification Status ────────────────────────── */}
                    {verifications.length > 0 && (
                        <SectionCard title="Verification Status (Customer)">
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
                                    </tbody>
                                </table>
                            </div>

                            <div className="mt-4 flex items-center gap-4 text-xs">
                                <span className="font-bold text-gray-500">Consent:</span>
                                <ConsentStatusBadge status={consentStatus} />
                            </div>
                        </SectionCard>
                    )}
                </main>

                {/* ─── Bottom Bar ────────────────────────────────────── */}
                <StickyBottomBar lastSaved={lastSaved}>
                    <OutlineButton onClick={() => router.push('/dealer-portal/leads')}>Back</OutlineButton>
                    <SecondaryButton onClick={() => handleSaveDraft(false)} loading={savingDraft}>Save Draft</SecondaryButton>
                    <PrimaryButton onClick={handleSaveAndNext} loading={submitting} disabled={submitting}>
                        Next <ChevronRight className="w-4 h-4" />
                    </PrimaryButton>
                </StickyBottomBar>
            </div>
        </div>
    );
}
