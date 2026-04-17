'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    AlertCircle, CheckCircle2, ChevronRight, Clock,
    Download, Loader2, RefreshCw, Send, Shield, Upload, X, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
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

// Once the customer has signed (digitally or via uploaded PDF), further consent actions
// must be blocked so the dealer can't fire a second SMS or regenerate a PDF.
function isConsentSignedOrLater(status: string) {
    return [
        'esign_completed',
        'consent_uploaded',
        'admin_review_pending',
        'admin_verified',
        'manual_verified',
        'verified',
    ].includes((status || '').toLowerCase());
}

function ConsentStatusBadge({ status }: { status: string }) {
    const s = (status || '').toLowerCase();
    if (isFinalConsentStatus(s)) {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Admin Verified</span>;
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

    // Consent flow state — digital and manual are mutually exclusive.
    const [consentPath, setConsentPath] = useState<'none' | 'digital' | 'manual'>('none');
    const [consentLoading, setConsentLoading] = useState(false);
    const [consentPdfUrl, setConsentPdfUrl] = useState<string | null>(null);
    const [consentRecord, setConsentRecord] = useState<any>(null);

    // Coupon state
    const [couponCode, setCouponCode] = useState('');
    const [couponValidating, setCouponValidating] = useState(false);
    const [couponResult, setCouponResult] = useState<any>(null);
    const [releasingCoupon, setReleasingCoupon] = useState(false);
    const [submittedForVerification, setSubmittedForVerification] = useState(false);

    // Re-upload state for failed verifications
    const reuploadInputRef = useRef<HTMLInputElement>(null);
    const [reuploadType, setReuploadType] = useState<string | null>(null);
    const [reuploading, setReuploading] = useState(false);

    // Requested docs from admin
    const [requestedDocs, setRequestedDocs] = useState<any[]>([]);
    const [uploadingRequestId, setUploadingRequestId] = useState<string | null>(null);

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

            if (fetchedLead?.coupon_code && fetchedLead?.coupon_status === 'reserved') {
                setCouponCode(fetchedLead.coupon_code);
                setCouponResult({ valid: true, success: true, coupon_code: fetchedLead.coupon_code, status: 'reserved', message: 'Coupon reserved' });
            } else if (fetchedLead?.coupon_code && fetchedLead?.coupon_status === 'used') {
                setCouponCode(fetchedLead.coupon_code);
                setCouponResult({ valid: true, success: true, coupon_code: fetchedLead.coupon_code, status: 'used', message: 'Coupon used' });
                setSubmittedForVerification(true);
            }

            const [docsRes, verificationsRes, consentRes, requestedDocsRes] = await Promise.allSettled([
                fetch(`/api/kyc/${leadId}/documents?doc_for=customer`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/verifications?verification_for=customer`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/consent/status?consent_for=customer`, { cache: 'no-store' }),
                fetch(`/api/kyc/${leadId}/requested-docs?doc_for=primary`, { cache: 'no-store' }),
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
                    if (consentJson.data.consent_status) setConsentStatus(consentJson.data.consent_status);
                }
            }

            if (requestedDocsRes.status === 'fulfilled') {
                const rdJson = await requestedDocsRes.value.json();
                if (rdJson?.success && Array.isArray(rdJson.data)) {
                    setRequestedDocs(rdJson.data);
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

    // Poll Digio / admin review states so the UI self-updates.
    useEffect(() => {
        const digioSyncStatuses = ['link_sent', 'link_opened', 'esign_in_progress', 'esign_completed'];
        const adminWaitStatuses = ['esign_completed', 'admin_review_pending', 'consent_uploaded'];
        const needsPoll = digioSyncStatuses.includes(consentStatus) || adminWaitStatuses.includes(consentStatus);
        if (!needsPoll) return;
        const tick = async () => {
            if (digioSyncStatuses.includes(consentStatus)) {
                try { await fetch(`/api/kyc/${leadId}/consent/sync`, { method: 'POST', cache: 'no-store' }); } catch {}
            }
            loadPageData(true);
        };
        const interval = setInterval(tick, 10000);
        return () => clearInterval(interval);
    }, [consentStatus, leadId]);

    useEffect(() => {
        const interval = setInterval(() => {
            if (!loading && !accessDenied && Object.keys(uploadedDocs).length > 0) handleSaveDraft(true);
        }, 120000);
        return () => clearInterval(interval);
    }, [loading, accessDenied, uploadedDocs, consentStatus]);

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
            [documentType]: {
                ...(prev[documentType] || {}),
                doc_type: documentType,
                verification_status: 'pending',
                doc_status: 'uploaded',
                file_url: prev[documentType]?.file_url || null,
            },
        }));

        try {
            setApiError(null);
            const formData = new FormData();
            formData.append('file', file);
            formData.append('documentType', documentType);
            formData.append('docType', documentType);
            formData.append('docFor', 'customer');

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
                    file_url: data?.fileUrl || data?.file_url || prev[documentType]?.file_url || null,
                    file_name: file.name,
                    file_size: file.size,
                    uploaded_at: new Date().toISOString(),
                },
            }));
            toast.success(`${documentType.replace(/_/g, ' ')} uploaded successfully`);
            await loadPageData(true);
        } catch (err: any) {
            setApiError(err?.message || 'Document upload failed');
        }
    };

    const triggerReupload = (verificationType: string) => {
        setReuploadType(verificationType);
        reuploadInputRef.current?.click();
    };

    const handleReuploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !reuploadType) return;

        if (!['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'].includes(file.type)) {
            setApiError('Only PNG, JPEG, JPG, and PDF files are allowed');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setApiError('File size must be 5MB or smaller');
            return;
        }

        setReuploading(true);
        setApiError(null);
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('verificationType', reuploadType);

            const res = await fetch(`/api/kyc/${leadId}/re-upload`, { method: 'POST', body: formData });
            const data = await res.json();

            if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Re-upload failed');

            await loadPageData(true);
        } catch (err: any) {
            setApiError(err?.message || 'Re-upload failed');
        } finally {
            setReuploading(false);
            setReuploadType(null);
            if (reuploadInputRef.current) reuploadInputRef.current.value = '';
        }
    };

    const handleRequestedDocUpload = async (requestId: string, file: File) => {
        if (file.size > 5 * 1024 * 1024) { setApiError('File must be under 5MB'); return; }
        setUploadingRequestId(requestId);
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('requestId', requestId);
            const res = await fetch(`/api/kyc/${leadId}/requested-docs`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                toast.success('Document uploaded successfully');
                setRequestedDocs(prev => prev.map(d =>
                    d.id === requestId ? { ...d, file_url: data.fileUrl, upload_status: 'uploaded', uploaded_at: new Date().toISOString() } : d
                ));
            } else {
                toast.error(data.error?.message || 'Upload failed');
            }
        } catch { toast.error('Upload failed'); }
        finally { setUploadingRequestId(null); }
    };

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

            if (data.hasDigioIntegration) {
                toast.success(`Consent SMS sent to customer via DigiO. They will receive a signing link shortly.`);
            } else {
                // DigiO failed — show warning with manual link
                toast.warning(
                    data.warning || 'SMS could not be sent automatically. Share the consent link manually.',
                    { duration: 10000 }
                );
                if (data.consentLink) {
                    // Copy to clipboard for manual sharing
                    try {
                        await navigator.clipboard.writeText(data.consentLink);
                        toast.info('Consent link copied to clipboard. Share it with the customer manually.', { duration: 6000 });
                    } catch {}
                }
            }
        } catch (err: any) {
            setApiError(err?.message || 'Failed to send consent');
            toast.error(err?.message || 'Failed to send consent');
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

    useEffect(() => {
        const digitalStatuses = ['link_sent', 'link_opened', 'esign_in_progress', 'esign_completed'];
        const manualStatuses = ['consent_generated', 'consent_uploaded'];
        if (digitalStatuses.includes(consentStatus)) setConsentPath('digital');
        else if (manualStatuses.includes(consentStatus)) setConsentPath('manual');
    }, [consentStatus]);

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
                    setLead((prev: any) => prev ? { ...prev, coupon_code: data.coupon_code, coupon_status: data.status } : prev);
                } else {
                    setLead((prev: any) => prev ? { ...prev, coupon_code: data.coupon_code, coupon_status: 'reserved' } : prev);
                    toast.success(`Coupon "${data.coupon_code}" validated and reserved for this lead.`);
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
                toast.success('Verification submitted successfully! KYC verification is now in progress.');
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

    if (loading) return <FullPageLoader />;

    if (accessDenied) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
                <div className="text-center max-w-md">
                    <Shield className="w-14 h-14 text-amber-400 mx-auto mb-4" />
                    <h2 className="text-2xl font-bold text-gray-900">KYC Not Available</h2>
                    <p className="mt-2 text-sm text-gray-500">
                        {lead?.payment_method === 'cash' || lead?.payment_method === 'upfront'
                            ? 'KYC verification is not required for cash/upfront payment leads.'
                            : 'KYC is only available for leads with a finance payment method.'}
                    </p>
                    {lead && (
                        <div className="mt-4 p-4 bg-white border border-gray-200 rounded-xl text-left text-sm">
                            <p><span className="font-semibold text-gray-700">Name:</span> {lead.full_name || lead.owner_name || '-'}</p>
                            <p><span className="font-semibold text-gray-700">Phone:</span> {lead.phone || lead.owner_contact || '-'}</p>
                            <p><span className="font-semibold text-gray-700">Payment:</span> {(lead.payment_method || '-').replace(/_/g, ' ')}</p>
                            <p><span className="font-semibold text-gray-700">Status:</span> {lead.lead_status || '-'}</p>
                        </div>
                    )}
                    <button onClick={() => router.push('/dealer-portal/leads')} className="mt-6 px-6 py-3 bg-[#0047AB] text-white rounded-xl font-bold">Back to Leads</button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1200px] mx-auto px-6 py-8 pb-40">
                <ProgressHeader
                    title="KYC"
                    subtitle={`Reference ID: ${lead?.reference_id || leadId}${lead?.full_name ? ` — ${lead.full_name}` : ''}`}
                    step={2}
                    onBack={() => router.back()}
                    rightAction={
                        <button onClick={async () => {
                            try { await fetch(`/api/kyc/${leadId}/consent/sync`, { method: 'POST', cache: 'no-store' }); } catch {}
                            loadPageData(true);
                        }} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold">
                            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
                        </button>
                    }
                />

                <ErrorBanner message={apiError} onDismiss={() => setApiError(null)} />

                <main className="grid grid-cols-1 gap-6">
                    <SectionCard title="Customer Consent" action={<ConsentStatusBadge status={consentStatus} />}>
                        {isFinalConsentStatus(consentStatus) ? (
                            <div className="space-y-3">
                                <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                                    <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                                        <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-emerald-800">Admin Verified Successfully</p>
                                        <p className="text-xs text-emerald-600 mt-0.5">The admin has verified the customer consent. You can now proceed to the next step.</p>
                                    </div>
                                </div>
                                {consentRecord?.signed_consent_url && (
                                    <a href={consentRecord.signed_consent_url} target="_blank" rel="noopener noreferrer"
                                        className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-emerald-200 rounded-lg text-xs font-bold text-emerald-700 hover:bg-emerald-50 transition-all">
                                        <Download className="w-3.5 h-3.5" /> Download Signed Consent PDF
                                    </a>
                                )}
                            </div>
                        ) : consentStatus === 'admin_review_pending' ? (
                            <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                                <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                                <div>
                                    <p className="text-sm font-bold text-amber-800">Awaiting Admin Verification</p>
                                    <p className="text-xs text-amber-600 mt-0.5">Signed consent has been uploaded and is pending admin review.</p>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <p className="text-sm text-gray-500">Choose one method to obtain customer consent. Both options are mutually exclusive.</p>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {/* Digital Consent Card */}
                                    <div className={`relative p-5 rounded-2xl border-2 transition-all ${
                                        consentPath === 'digital'
                                            ? 'border-[#0047AB] bg-blue-50/50 shadow-md'
                                            : consentPath === 'manual'
                                                ? 'border-gray-100 bg-gray-50 opacity-50 pointer-events-none'
                                                : 'border-gray-200 bg-white hover:border-[#0047AB] hover:shadow-md'
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
                                            <>
                                                <div className="flex gap-2">
                                                    <button disabled
                                                        title="WhatsApp consent is currently unavailable"
                                                        className="flex-1 px-3 py-2 bg-gray-300 text-gray-500 rounded-lg text-xs font-bold cursor-not-allowed flex items-center justify-center gap-1.5">
                                                        <Send className="w-3 h-3" />
                                                        WhatsApp
                                                        <span className="text-[9px] font-normal">(Coming soon)</span>
                                                    </button>
                                                    <button onClick={() => handleSendConsent('sms')}
                                                        disabled={consentLoading || isConsentSignedOrLater(consentStatus)}
                                                        title={isConsentSignedOrLater(consentStatus) ? 'Customer has already signed' : undefined}
                                                        className="flex-1 px-3 py-2 bg-[#0047AB] text-white rounded-lg text-xs font-bold hover:bg-[#003580] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5">
                                                        {consentLoading && consentPath === 'digital' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                                        {consentStatus === 'esign_completed' ? 'Signed' : 'SMS'}
                                                    </button>
                                                </div>
                                                {lead?.phone && (
                                                    <p className="text-xs text-gray-500 mt-2">
                                                        Consent SMS will be sent to: <span className="font-mono font-bold text-gray-700">{lead.phone}</span>
                                                    </p>
                                                )}
                                            </>
                                        )}
                                        {(consentStatus === 'link_sent' || consentStatus === 'link_opened') && (
                                            <div className="mt-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2">
                                                <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                                                </span>
                                                <p className="text-xs font-medium text-amber-700">
                                                    {consentStatus === 'link_opened' ? 'Customer opened the link. Waiting for signature...' : 'Consent link sent. Waiting for customer to sign...'}
                                                </p>
                                            </div>
                                        )}
                                        {consentStatus === 'esign_completed' && (
                                            <div className="mt-3 p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2">
                                                <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                                                <p className="text-xs font-medium text-emerald-700">
                                                    Customer has signed the consent. Submit for admin verification to proceed.
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
                                                : 'border-gray-200 bg-white hover:border-[#0047AB] hover:shadow-md'
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
                                                <button onClick={handleGenerateConsentPDF}
                                                    disabled={consentLoading || consentStatus === 'consent_generated' || isConsentSignedOrLater(consentStatus)}
                                                    title={isConsentSignedOrLater(consentStatus) ? 'Customer has already signed' : undefined}
                                                    className="w-full px-3 py-2 bg-teal-600 text-white rounded-lg text-xs font-bold hover:bg-teal-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5">
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
                                                        <label className={`w-full px-3 py-2 bg-[#0047AB] text-white rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                                                            isConsentSignedOrLater(consentStatus)
                                                                ? 'opacity-50 cursor-not-allowed pointer-events-none'
                                                                : 'hover:bg-[#003580] cursor-pointer'
                                                        }`}>
                                                            <Upload className="w-3 h-3" /> Upload Signed Consent PDF
                                                            <input type="file" className="hidden" accept="application/pdf"
                                                                disabled={isConsentSignedOrLater(consentStatus)}
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

                    <SectionCard title="Loan Documents" action={
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-gray-500">Uploaded:</span>
                            <span className={`text-sm font-black ${docStats.uploadedCount === docStats.total ? 'text-emerald-600' : 'text-[#0047AB]'}`}>
                                {docStats.uploadedCount}/{docStats.total}
                            </span>
                            {docStats.uploadedCount === docStats.total && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                        </div>
                    }>
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

                    <SectionCard title="Verification Action" action={
                        lead?.coupon_status === 'used'
                            ? <span className="text-xs font-bold text-emerald-600">Submitted</span>
                            : lead?.coupon_status === 'reserved'
                                ? <span className="text-xs font-bold text-blue-600">Reserved</span>
                                : null
                    }>
                        {lead?.coupon_status === 'used' || submittedForVerification ? (
                            <div className="flex items-center gap-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                                <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                                <p className="text-sm text-emerald-800">Verification submitted. Coupon <span className="font-mono font-bold">{couponCode}</span> consumed.</p>
                            </div>
                        ) : (
                            <div className="flex items-center gap-3 flex-wrap">
                                <input
                                    type="text"
                                    value={couponCode}
                                    onChange={e => setCouponCode(e.target.value.toUpperCase())}
                                    placeholder="Enter coupon code"
                                    maxLength={20}
                                    className="h-10 px-4 bg-white border border-gray-300 rounded-lg outline-none text-sm font-mono focus:border-[#1D4ED8] transition-all w-48"
                                />
                                <button
                                    onClick={handleValidateCoupon}
                                    disabled={couponValidating || !couponCode.trim()}
                                    className="h-10 px-5 bg-white border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-40 flex items-center gap-2"
                                >
                                    {couponValidating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                    Validate
                                </button>
                                <button
                                    onClick={handleSubmitForVerification}
                                    disabled={submitting || !(lead?.coupon_status === 'reserved')}
                                    className="h-10 px-5 bg-white border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-40 flex items-center gap-2"
                                >
                                    {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                    Submit for Verification
                                </button>
                                {lead?.coupon_status === 'reserved' && (
                                    <button
                                        onClick={handleReleaseCoupon}
                                        disabled={releasingCoupon}
                                        className="h-10 px-3 text-xs font-medium text-gray-500 hover:text-red-600 transition-all disabled:opacity-40 flex items-center gap-1"
                                    >
                                        <X className="w-3 h-3" /> Change
                                    </button>
                                )}
                            </div>
                        )}
                        {couponResult && !couponResult.valid && !couponResult.success && !couponResult.already_used && (
                            <p className="text-xs text-red-600 mt-2"><AlertCircle className="w-3 h-3 inline mr-1" />{couponResult.message || 'Invalid coupon code'}</p>
                        )}
                        {couponResult && couponResult.already_used && (
                            <p className="text-xs text-amber-600 mt-2"><AlertCircle className="w-3 h-3 inline mr-1" />Coupon already applied to this lead.</p>
                        )}
                    </SectionCard>

                    <input
                        ref={reuploadInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,application/pdf"
                        className="hidden"
                        onChange={handleReuploadFile}
                    />

                    {(() => {
                        // Fixed verification checks matching the reference design
                        const FIXED_CHECKS = [
                            { type: 'aadhaar', label: 'Aadhaar Verification', docKeys: ['aadhaar_front', 'aadhaar_back'] },
                            { type: 'pan', label: 'PAN Verification', docKeys: ['pan_card'] },
                            { type: 'bank', label: 'Bank Verification', docKeys: ['bank_statement'] },
                            { type: 'rc', label: 'RC Verification', docKeys: ['rc_copy'] },
                            { type: 'mobile', label: 'Mobile Number', docKeys: [] },
                        ];

                        // Build a lookup from API verifications
                        const apiVerMap: Record<string, VerificationRow> = {};
                        for (const v of verifications) {
                            apiVerMap[v.type] = v;
                        }

                        const rows = FIXED_CHECKS.map(check => {
                            // 1. For mobile — always success if phone exists
                            if (check.type === 'mobile') {
                                return {
                                    type: 'mobile',
                                    label: 'Mobile Number',
                                    status: lead?.phone ? 'success' : 'pending',
                                    last_update: null,
                                    failed_reason: null,
                                } as VerificationRow;
                            }

                            // 2. Check uploaded document statuses first (admin review results)
                            const docs = check.docKeys.map(k => uploadedDocs[k]).filter(Boolean);

                            if (docs.length > 0) {
                                // If any doc is failed/rejected by admin
                                const failedDoc = docs.find(d => d.verification_status === 'failed' || d.verification_status === 'rejected');
                                if (failedDoc) {
                                    return {
                                        type: check.type,
                                        label: check.label,
                                        status: 'failed',
                                        last_update: failedDoc.uploaded_at || null,
                                        failed_reason: failedDoc.rejection_reason || failedDoc.failed_reason || null,
                                    } as VerificationRow;
                                }

                                // If all docs are verified/accepted by admin
                                const allSuccess = docs.every(d => d.verification_status === 'success' || d.verification_status === 'verified');
                                if (allSuccess) {
                                    return {
                                        type: check.type,
                                        label: check.label,
                                        status: 'success',
                                        last_update: docs[0]?.uploaded_at || null,
                                        failed_reason: null,
                                    } as VerificationRow;
                                }
                            }

                            // 3. Fall back to API verification result (from Decentro)
                            const apiVer = apiVerMap[check.type];
                            if (apiVer) {
                                return apiVer;
                            }

                            // 4. No docs uploaded yet
                            if (docs.length === 0) {
                                return {
                                    type: check.type,
                                    label: check.label,
                                    status: 'pending',
                                    last_update: null,
                                    failed_reason: null,
                                } as VerificationRow;
                            }

                            // If in progress
                            const anyInProgress = docs.some(d => d.verification_status === 'in_progress' || d.verification_status === 'initiating');
                            if (anyInProgress) {
                                return {
                                    type: check.type,
                                    label: check.label,
                                    status: 'initiating',
                                    last_update: docs[0]?.uploaded_at || null,
                                    failed_reason: null,
                                } as VerificationRow;
                            }

                            // Default: awaiting action (uploaded but not yet reviewed)
                            return {
                                type: check.type,
                                label: check.label,
                                status: 'awaiting_action',
                                last_update: docs[0]?.uploaded_at || null,
                                failed_reason: null,
                            } as VerificationRow;
                        });

                        return (
                            <SectionCard title="Verification Status (Customer)" action={
                                <span className="text-sm">
                                    Consent Status: {' '}
                                    <span className={`font-bold ${
                                        isFinalConsentStatus(consentStatus) ? 'text-emerald-600' :
                                        consentStatus === 'esign_failed' || consentStatus === 'admin_rejected' ? 'text-red-600' :
                                        'text-gray-700'
                                    }`}>
                                        {isFinalConsentStatus(consentStatus) ? 'Success' :
                                         consentStatus === 'link_sent' ? 'Link Sent' :
                                         consentStatus === 'esign_in_progress' ? 'Signing...' :
                                         consentStatus === 'esign_completed' ? 'Signed' :
                                         consentStatus.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                    </span>
                                </span>
                            }>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-gray-200">
                                                <th className="text-left py-2.5 px-3 font-semibold text-gray-500 text-xs">Check</th>
                                                <th className="text-left py-2.5 px-3 font-semibold text-gray-500 text-xs">Status</th>
                                                <th className="text-left py-2.5 px-3 font-semibold text-gray-500 text-xs">Last Update</th>
                                                <th className="text-left py-2.5 px-3 font-semibold text-gray-500 text-xs">Action</th>
                                                <th className="text-left py-2.5 px-3 font-semibold text-gray-500 text-xs">Failed Reason</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.map((v, i) => (
                                                <tr key={i} className="border-b border-gray-50">
                                                    <td className="py-3 px-3 font-medium text-gray-900">{v.label}</td>
                                                    <td className="py-3 px-3"><StatusBadge status={v.status} /></td>
                                                    <td className="py-3 px-3 text-gray-500 text-xs">
                                                        {v.last_update ? new Date(v.last_update).toLocaleString() : '-'}
                                                    </td>
                                                    <td className="py-3 px-3">
                                                        {(v.status === 'failed' || v.status === 'rejected') ? (
                                                            <button
                                                                onClick={() => triggerReupload(v.type)}
                                                                disabled={reuploading && reuploadType === v.type}
                                                                className="text-xs font-semibold px-3 py-1.5 rounded flex items-center gap-1 disabled:opacity-50 transition-all bg-orange-500 text-white hover:bg-orange-600"
                                                            >
                                                                {reuploading && reuploadType === v.type ? (
                                                                    <><Loader2 className="w-3 h-3 animate-spin" /> uploading...</>
                                                                ) : (
                                                                    <>re-upload</>
                                                                )}
                                                            </button>
                                                        ) : v.status === 'success' || v.status === 'verified' ? (
                                                            <span className="text-xs font-semibold text-emerald-600 flex items-center gap-1">
                                                                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                                                                Verified
                                                            </span>
                                                        ) : v.status === 'awaiting_action' ? (
                                                            <span className="text-xs font-medium text-amber-600 flex items-center gap-1">
                                                                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.828a1 1 0 101.415-1.414L11 9.586V6z" clipRule="evenodd" /></svg>
                                                                Pending Admin Review
                                                            </span>
                                                        ) : v.status === 'pending' ? (
                                                            <span className="text-xs text-gray-400">Not started</span>
                                                        ) : v.status === 'initiating' || v.status === 'in_progress' ? (
                                                            <span className="text-xs font-medium text-blue-600 flex items-center gap-1">
                                                                <Loader2 className="w-3 h-3 animate-spin" />
                                                                In progress
                                                            </span>
                                                        ) : null}
                                                    </td>
                                                    <td className="py-3 px-3 text-xs text-gray-600">{v.failed_reason || ''}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </SectionCard>
                        );
                    })()}

                    {requestedDocs.length > 0 && (
                        <SectionCard title="Requested Documents" action={
                            <span className="text-xs font-semibold text-amber-600">
                                {requestedDocs.filter(d => d.upload_status === 'not_uploaded').length} pending
                            </span>
                        }>
                            <p className="text-xs text-gray-500 mb-4">The admin has requested the following documents. Please upload them to continue the verification process.</p>
                            <div className="space-y-3">
                                {requestedDocs.map(doc => (
                                    <div key={doc.id} className={`flex items-center justify-between p-4 rounded-xl border ${
                                        doc.upload_status === 'uploaded' ? 'border-emerald-200 bg-emerald-50/50' :
                                        doc.upload_status === 'rejected' ? 'border-red-200 bg-red-50/50' :
                                        'border-amber-200 bg-amber-50/50'
                                    }`}>
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm font-bold text-gray-900">{doc.doc_label}</p>
                                                {doc.is_required && <span className="text-red-500 text-xs">*</span>}
                                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                                    doc.upload_status === 'uploaded' ? 'bg-emerald-100 text-emerald-700' :
                                                    doc.upload_status === 'rejected' ? 'bg-red-100 text-red-700' :
                                                    'bg-amber-100 text-amber-700'
                                                }`}>
                                                    {doc.upload_status === 'not_uploaded' ? 'Pending Upload' :
                                                     doc.upload_status === 'uploaded' ? 'Uploaded' :
                                                     doc.upload_status === 'verified' ? 'Verified' :
                                                     doc.upload_status === 'rejected' ? 'Rejected' : doc.upload_status}
                                                </span>
                                            </div>
                                            {doc.rejection_reason && (
                                                <p className="text-xs text-red-600 mt-1">Reason: {doc.rejection_reason}</p>
                                            )}
                                            {doc.created_at && (
                                                <p className="text-[10px] text-gray-400 mt-1">Requested {new Date(doc.created_at).toLocaleString()}</p>
                                            )}
                                        </div>
                                        {(doc.upload_status === 'not_uploaded' || doc.upload_status === 'rejected') && (
                                            <label className={`px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition-all flex items-center gap-2 ${
                                                uploadingRequestId === doc.id ? 'bg-gray-200 text-gray-500' : 'bg-[#0047AB] text-white hover:bg-[#003580]'
                                            }`}>
                                                {uploadingRequestId === doc.id ? (
                                                    <><Loader2 className="w-3 h-3 animate-spin" /> Uploading...</>
                                                ) : (
                                                    <><Upload className="w-3 h-3" /> Upload</>
                                                )}
                                                <input
                                                    type="file"
                                                    className="hidden"
                                                    accept="image/png,image/jpeg,application/pdf"
                                                    disabled={uploadingRequestId === doc.id}
                                                    onChange={e => e.target.files?.[0] && handleRequestedDocUpload(doc.id, e.target.files[0])}
                                                />
                                            </label>
                                        )}
                                        {doc.upload_status === 'uploaded' && (
                                            <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                                        )}
                                    </div>
                                ))}
                            </div>
                        </SectionCard>
                    )}
                </main>

                <StickyBottomBar lastSaved={lastSaved}>
                    <OutlineButton onClick={() => router.push('/dealer-portal/leads')}>Back</OutlineButton>
                    <SecondaryButton onClick={() => handleSaveDraft(false)} loading={savingDraft}>Save Draft</SecondaryButton>
                    {(() => {
                        const consentDone = isFinalConsentStatus(consentStatus);
                        const allDocsUploaded = docStats.uploadedCount === docStats.total && docStats.total > 0;
                        const canProceed = consentDone && allDocsUploaded;
                        return (
                            <div className="relative group">
                                <PrimaryButton
                                    onClick={handleSaveAndNext}
                                    loading={submitting}
                                    disabled={submitting || !canProceed}
                                >
                                    Next <ChevronRight className="w-4 h-4" />
                                </PrimaryButton>
                                {!canProceed && (
                                    <div className="absolute bottom-full mb-2 right-0 bg-gray-800 text-white text-xs rounded-lg px-3 py-2 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                        {!consentDone && !allDocsUploaded
                                            ? 'Complete consent verification and upload all documents'
                                            : !consentDone
                                                ? 'Consent must be verified by admin'
                                                : 'Upload all required documents'}
                                    </div>
                                )}
                            </div>
                        );
                    })()}
                </StickyBottomBar>
            </div>
        </div>
    );
}
