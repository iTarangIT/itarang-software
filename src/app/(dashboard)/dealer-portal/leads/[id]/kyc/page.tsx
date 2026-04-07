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

    // Coupon state
    const [couponCode, setCouponCode] = useState('');
    const [couponValidating, setCouponValidating] = useState(false);
    const [couponResult, setCouponResult] = useState<any>(null);
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

            const [docsRes, verificationsRes] = await Promise.allSettled([
                fetch(`/api/kyc/${leadId}/documents`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/verifications`, { cache: 'no-store' }),
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
        } catch {
            setApiError('Failed to load KYC data');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => { loadPageData(); }, [leadId]);

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
            doc.key === 'rc_copy' ? { ...doc, required: isVehicle } : { ...doc, required: true }
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
            const res = await fetch(`/api/kyc/${leadId}/send-consent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel }),
            });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.message || 'Failed to send consent');
            setConsentStatus('link_sent');
        } catch (err: any) {
            setApiError(err?.message || 'Failed to send consent');
        }
    };

    const handleGenerateConsentPDF = async () => {
        try {
            setApiError(null);
            const res = await fetch(`/api/kyc/${leadId}/generate-consent-pdf`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.message || 'Failed to generate consent PDF');
            setConsentStatus('manual_pdf_generated');
            if (data.pdfUrl) window.open(data.pdfUrl, '_blank');
        } catch (err: any) {
            setApiError(err?.message || 'Failed to generate consent PDF');
        }
    };

    const handleUploadSignedConsent = async (file: File) => {
        try {
            setApiError(null);
            if (file.type !== 'application/pdf') throw new Error('Only PDF files allowed');
            if (file.size > 10 * 1024 * 1024) throw new Error('Max 10MB');
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`/api/kyc/${leadId}/upload-signed-consent`, { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.message || 'Upload failed');
            setConsentStatus('manual_uploaded');
        } catch (err: any) {
            setApiError(err?.message || 'Failed to upload signed consent');
        }
    };

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
            if (!data.success && !data.valid) setApiError(data.message || data.error || 'Invalid coupon');
        } catch {
            setApiError('Coupon validation failed');
        } finally {
            setCouponValidating(false);
        }
    };

    const handleSubmitForVerification = async () => {
        try {
            setApiError(null);
            setSubmitting(true);
            const res = await fetch(`/api/kyc/${leadId}/submit-verification`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await res.json();
            if (data.success) {
                setSubmittedForVerification(true);
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
        if (docStats.uploadedCount < docStats.total) {
            setApiError(`Missing documents: ${docStats.pending.map(d => d.label).join(', ')}`);
            return;
        }
        if (!isFinalConsentStatus(consentStatus)) {
            setApiError('Consent must be verified before proceeding');
            return;
        }

        try {
            setSubmitting(true);
            setApiError(null);
            const res = await fetch(`/api/kyc/${leadId}/complete-step2`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.message || 'Failed to proceed');
            router.push(`/dealer-portal/leads/${leadId}/kyc/interim`);
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

    const consentLabel = consentStatus.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

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
                    <SectionCard title="Customer Consent">
                        <div className="flex flex-wrap items-center gap-3 mb-4">
                            <button
                                onClick={() => handleSendConsent('whatsapp')}
                                disabled={isFinalConsentStatus(consentStatus)}
                                className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-bold hover:border-[#0047AB] transition-all disabled:opacity-40"
                            >
                                <Send className="w-4 h-4" /> Send SMS/WhatsApp Consent
                            </button>
                            <button
                                onClick={handleGenerateConsentPDF}
                                disabled={isFinalConsentStatus(consentStatus)}
                                className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-bold hover:border-[#0047AB] transition-all disabled:opacity-40"
                            >
                                <Download className="w-4 h-4" /> Generate Consent PDF
                            </button>
                            <label className={`inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-bold hover:border-[#0047AB] transition-all cursor-pointer ${isFinalConsentStatus(consentStatus) ? 'opacity-40 pointer-events-none' : ''}`}>
                                <Upload className="w-4 h-4" /> Upload signed consent PDF
                                <input type="file" className="hidden" accept="application/pdf" onChange={e => e.target.files?.[0] && handleUploadSignedConsent(e.target.files[0])} />
                            </label>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-500">Consent Status:</span>
                            <span className={`text-sm font-bold ${
                                isFinalConsentStatus(consentStatus) ? 'text-green-700' :
                                consentStatus === 'link_sent' ? 'text-amber-700' :
                                'text-gray-600'
                            }`}>
                                {isFinalConsentStatus(consentStatus) ? 'Verified' : consentLabel}
                            </span>
                            {isFinalConsentStatus(consentStatus) && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                        </div>
                    </SectionCard>

                    {/* ─── Loan Documents ─────────────────────────────── */}
                    <SectionCard title="Loan Documents">
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-6">
                            {requiredDocs.map(doc => (
                                <DocumentCard
                                    key={doc.key}
                                    label={doc.label}
                                    required={doc.required}
                                    uploaded={!!uploadedDocs[doc.key]?.file_url}
                                    status={uploadedDocs[doc.key]?.verification_status || uploadedDocs[doc.key]?.doc_status}
                                    failedReason={uploadedDocs[doc.key]?.rejection_reason || uploadedDocs[doc.key]?.failed_reason}
                                    onUpload={file => handleDocUpload(doc.key, file)}
                                />
                            ))}
                        </div>

                        <div className="flex items-center gap-4 pt-2 border-t border-gray-100">
                            <span className="text-sm font-bold text-gray-900">
                                Documents Uploaded: <span className="text-[#0047AB]">{String(docStats.uploadedCount).padStart(2, '0')}/{docStats.total}</span>
                            </span>
                            {docStats.pending.length > 0 && (
                                <span className="text-sm font-medium text-red-600">
                                    Documents Pending: {docStats.pending.map(d => d.label).join(', ')}
                                </span>
                            )}
                        </div>
                    </SectionCard>

                    {/* ─── Verification Action ────────────────────────── */}
                    <SectionCard title="Verification Action">
                        <div className="flex items-center gap-3">
                            <input
                                type="text"
                                value={couponCode}
                                onChange={e => setCouponCode(e.target.value.toUpperCase())}
                                placeholder="Enter coupon code"
                                maxLength={20}
                                className="flex-1 h-11 px-4 bg-white border-2 border-[#EBEBEB] rounded-xl outline-none text-sm focus:border-[#1D4ED8] transition-all"
                            />
                            <button
                                onClick={handleValidateCoupon}
                                disabled={couponValidating || !couponCode.trim()}
                                className="px-6 py-2.5 bg-white border-2 border-[#0047AB] rounded-xl text-sm font-bold text-[#0047AB] hover:bg-blue-50 transition-all disabled:opacity-50 flex items-center gap-2"
                            >
                                {couponValidating && <Loader2 className="w-4 h-4 animate-spin" />}
                                Validate
                            </button>
                            <button
                                onClick={handleSubmitForVerification}
                                disabled={submitting || !(couponResult?.success || couponResult?.valid)}
                                className="px-6 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center gap-2"
                            >
                                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                                Submit for Verification
                            </button>
                        </div>

                        {couponResult && (couponResult.success || couponResult.valid) && (
                            <div className="mt-3 px-4 py-2 bg-green-50 border border-green-200 rounded-xl">
                                <p className="text-sm font-medium text-green-700">
                                    <CheckCircle2 className="w-4 h-4 inline mr-1" />
                                    Coupon validated successfully
                                    {couponResult.coupon?.value ? ` — ₹${couponResult.coupon.value} off` : ''}
                                </p>
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
                                <span className="font-bold text-gray-500">Consent Status:</span>
                                <span className={`font-bold ${isFinalConsentStatus(consentStatus) ? 'text-green-700' : 'text-amber-700'}`}>
                                    {isFinalConsentStatus(consentStatus) ? 'Verified' : consentLabel}
                                </span>
                                <span className="font-bold text-gray-500 ml-4">Substatus:</span>
                                <span className="font-medium text-gray-600">{consentLabel}</span>
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
