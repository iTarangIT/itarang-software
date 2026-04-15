'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
    ChevronLeft, Loader2, Upload, CheckCircle2, XCircle,
    AlertCircle, Clock, Info, X, FileText, Camera, Shield,
    Send, Download, Eye, ChevronRight,
    ArrowRight, Table2, Landmark, RefreshCw
} from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';

// ── Constants ────────────────────────────────────────────────────────────────

const FINANCE_DOCUMENTS = [
    { key: 'aadhaar_front', label: 'Aadhaar Front', required: true },
    { key: 'aadhaar_back', label: 'Aadhaar Back', required: true },
    { key: 'pan_card', label: 'PAN Card', required: true },
    { key: 'passport_photo', label: 'Passport Size Photo', required: true },
    { key: 'address_proof', label: 'Address Proof', required: true },
    { key: 'rc_copy', label: 'RC Copy', required: false, conditional: true },
    { key: 'bank_statement', label: 'Bank Statement', required: true },
    { key: 'cheque_1', label: 'Undated Cheque 1', required: true },
    { key: 'cheque_2', label: 'Undated Cheque 2', required: true },
    { key: 'cheque_3', label: 'Undated Cheque 3', required: true },
    { key: 'cheque_4', label: 'Undated Cheque 4', required: true },
];

const UPFRONT_DOCUMENTS = [
    { key: 'aadhaar_front', label: 'Aadhaar Front', required: true },
    { key: 'aadhaar_back', label: 'Aadhaar Back', required: true },
    { key: 'pan_card', label: 'PAN Card', required: true },
];

type VerificationStatus = 'pending' | 'initiating' | 'awaiting_action' | 'in_progress' | 'success' | 'failed';

interface OcrComparisonField {
    field: string;
    label: string;
    ocrValue: string | null;
    leadValue: string | null;
    match: boolean;
    similarity?: number;
}

interface DocUpload {
    key: string;
    file_url: string | null;
    verification_status: VerificationStatus;
    failed_reason?: string;
    ocr_data?: Record<string, any> | null;
    ocr_comparison?: OcrComparisonField[] | null;
    ocr_failed?: boolean;
    enable_manual_entry?: boolean;
}

interface VerificationRow {
    type: string;
    label: string;
    status: VerificationStatus;
    last_update: string | null;
    failed_reason: string | null;
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function KYCPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;
    const { user } = useAuth();

    // Core
    const [loading, setLoading] = useState(true);
    const [lead, setLead] = useState<any>(null);
    const [accessDenied, setAccessDenied] = useState(false);
    const [apiError, setApiError] = useState<string | null>(null);

    // ── Document Upload State ──
    const [uploadedDocs, setUploadedDocs] = useState<Record<string, DocUpload>>({});
    const [ocrComparisons, setOcrComparisons] = useState<Record<string, OcrComparisonField[]>>({});

    // ── Manual Entry State ──
    const [manualEntryDoc, setManualEntryDoc] = useState<string | null>(null);
    const [manualFields, setManualFields] = useState<Record<string, string>>({
        name: '', father_name: '', dob: '', address: '', pan_number: '', aadhaar_number: '',
    });
    const [bankManualFields, setBankManualFields] = useState({
        account_holder_name: '', account_number: '', confirm_account_number: '',
        ifsc: '', bank_name: '', branch: '', account_type: 'savings',
    });
    const [bankManualErrors, setBankManualErrors] = useState<Record<string, string>>({});
    const [showBankManual, setShowBankManual] = useState(false);
    const [savingManual, setSavingManual] = useState(false);
    const [manualEntryTab, setManualEntryTab] = useState<'document' | 'bank'>('document');

    // ── Verification State ──
    const [verifications, setVerifications] = useState<VerificationRow[]>([]);
    const [consentStatus, setConsentStatus] = useState<string>('awaiting_signature');
    const [verificationSubmitted, setVerificationSubmitted] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    // ── Draft & Save ──
    const [saving, setSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<string | null>(null);

    // ── Submit State ──
    const [submitted, setSubmitted] = useState(false);

    // ── Load Data ────────────────────────────────────────────────────────────

    useEffect(() => {
        const loadData = async () => {
            try {
                const res = await fetch(`/api/kyc/${leadId}/access-check`);
                const data = await res.json();
                if (!data.success || !data.allowed) { setAccessDenied(true); return; }

                setLead(data.lead);
                if (data.lead.consent_status) setConsentStatus(data.lead.consent_status);

                // Load docs and verifications in parallel
                const [docsRes, verRes] = await Promise.all([
                    fetch(`/api/kyc/${leadId}/documents`),
                    fetch(`/api/kyc/${leadId}/verifications`),
                ]);

                const [docsData, verData] = await Promise.all([
                    docsRes.json(), verRes.json(),
                ]);

                if (docsData.success) {
                    const docMap: Record<string, DocUpload> = {};
                    docsData.data.forEach((d: any) => {
                        docMap[d.doc_type] = {
                            key: d.doc_type,
                            file_url: d.file_url,
                            verification_status: d.verification_status,
                            failed_reason: d.failed_reason,
                        };
                    });
                    setUploadedDocs(docMap);
                }

                if (verData.success) setVerifications(verData.data);

            } catch { setApiError('Failed to load KYC data'); }
            finally { setLoading(false); }
        };
        loadData();
    }, [leadId]);

    // ── Auto-save draft every 2 min ──
    useEffect(() => {
        const interval = setInterval(() => {
            if (Object.keys(uploadedDocs).length > 0) handleSaveDraft(true);
        }, 120000);
        return () => clearInterval(interval);
    }, [uploadedDocs, consentStatus]);

    // ── Helpers ──────────────────────────────────────────────────────────────

    const getRequiredDocs = () => {
        const isFinance = lead && ['finance', 'other_finance', 'dealer_finance'].includes(lead.payment_method);
        if (!isFinance) return UPFRONT_DOCUMENTS;
        const docs = [...FINANCE_DOCUMENTS];
        const isVehicle = lead && ['2W', '3W', '4W'].includes(lead.asset_model);
        return docs.map(d => d.key === 'rc_copy' ? { ...d, required: isVehicle } : d);
    };

    const getDocStats = () => {
        const required = getRequiredDocs().filter(d => d.required);
        const uploaded = required.filter(d => uploadedDocs[d.key]?.file_url);
        const pending = required.filter(d => !uploadedDocs[d.key]?.file_url);
        return { total: required.length, uploaded: uploaded.length, pending };
    };

    // ── Document Upload ──────────────────────────────────────────────────────

    const handleDocUpload = async (docType: string, file: File) => {
        if (file.size > 5 * 1024 * 1024) { setApiError('File size must be less than 5MB'); return; }
        const allowedTypes = ['image/png', 'image/jpeg', 'application/pdf'];
        if (!allowedTypes.includes(file.type)) { setApiError('Only PNG, JPEG, and PDF files are allowed'); return; }

        // Set uploading state
        setUploadedDocs(prev => ({ ...prev, [docType]: { key: docType, file_url: null, verification_status: 'initiating' } }));

        const formData = new FormData();
        formData.append('file', file);
        formData.append('docType', docType);

        try {
            const res = await fetch(`/api/kyc/${leadId}/upload-document`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                const docUpload: DocUpload = {
                    key: docType,
                    file_url: data.file_url,
                    verification_status: data.ocr_failed ? 'failed' : (data.ocr_data ? 'in_progress' : 'pending'),
                    failed_reason: data.ocr_error || data.warning || undefined,
                    ocr_data: data.ocr_data || null,
                    ocr_comparison: data.ocr_comparison || null,
                    ocr_failed: data.ocr_failed || false,
                    enable_manual_entry: data.enable_manual_entry || false,
                };
                setUploadedDocs(prev => ({ ...prev, [docType]: docUpload }));

                if (data.ocr_comparison?.length > 0) {
                    setOcrComparisons(prev => ({ ...prev, [docType]: data.ocr_comparison }));
                }
                if (data.warning) setApiError(data.warning);
                if (data.ocr_failed || data.enable_manual_entry) setManualEntryDoc(docType);

                // Auto address match
                if (docType === 'aadhaar_back' && data.ocr_data?.address) {
                    triggerAutoAddressMatch(data.ocr_data.address);
                }
            } else {
                setUploadedDocs(prev => ({ ...prev, [docType]: { key: docType, file_url: null, verification_status: 'failed', failed_reason: data.error?.message } }));
                setApiError(data.error?.message || 'Upload failed');
            }
        } catch {
            setUploadedDocs(prev => ({ ...prev, [docType]: { key: docType, file_url: null, verification_status: 'failed', failed_reason: 'Upload failed' } }));
            setApiError('Upload failed. Please try again.');
        }
    };

    const triggerAutoAddressMatch = (aadhaarAddress: string) => {
        if (!lead?.current_address) return;
        const a = aadhaarAddress.trim().toLowerCase().replace(/\s+/g, ' ');
        const b = (lead.current_address || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const similarity = a === b ? 100 : Math.round((1 - Math.abs(a.length - b.length) / Math.max(a.length, b.length)) * 100);
        if (similarity < 70) {
            setOcrComparisons(prev => ({
                ...prev,
                'address_match': [{
                    field: 'address', label: 'Address (Aadhaar vs Lead)',
                    ocrValue: aadhaarAddress, leadValue: lead.current_address,
                    match: false, similarity,
                }],
            }));
        }
    };

    // ── Manual Entry ─────────────────────────────────────────────────────────

    const handleSaveManualEntry = async () => {
        if (!manualEntryDoc) return;
        setSavingManual(true);
        try {
            const res = await fetch(`/api/kyc/${leadId}/save-draft`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    step: 2,
                    data: { manualOcrData: { [manualEntryDoc]: manualFields }, documents: uploadedDocs, consentStatus },
                }),
            });
            if (res.ok) {
                setUploadedDocs(prev => ({
                    ...prev,
                    [manualEntryDoc!]: { ...prev[manualEntryDoc!], verification_status: 'in_progress', ocr_failed: false, enable_manual_entry: false, ocr_data: manualFields },
                }));
                setManualEntryDoc(null);
                setManualFields({ name: '', father_name: '', dob: '', address: '', pan_number: '', aadhaar_number: '' });
            }
        } catch { setApiError('Failed to save manual entry'); }
        finally { setSavingManual(false); }
    };

    // ── Bank Manual Entry ──────────────────────────────────────────────────────

    const validateBankFields = () => {
        const errs: Record<string, string> = {};
        if (!bankManualFields.account_holder_name.trim()) errs.account_holder_name = 'Required';
        if (!bankManualFields.account_number.trim()) errs.account_number = 'Required';
        else if (bankManualFields.account_number.length < 9 || bankManualFields.account_number.length > 18) errs.account_number = '9-18 digits required';
        if (bankManualFields.account_number !== bankManualFields.confirm_account_number) errs.confirm_account_number = 'Account numbers do not match';
        if (!bankManualFields.ifsc.trim()) errs.ifsc = 'Required';
        else if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankManualFields.ifsc)) errs.ifsc = 'Invalid IFSC format (e.g. SBIN0001234)';
        if (!bankManualFields.bank_name.trim()) errs.bank_name = 'Required';
        setBankManualErrors(errs);
        return Object.keys(errs).length === 0;
    };

    const handleSaveBankManual = async () => {
        if (!validateBankFields()) return;
        setSavingManual(true);
        try {
            const res = await fetch(`/api/kyc/${leadId}/save-draft`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    step: 2,
                    data: { bankManualData: bankManualFields, documents: uploadedDocs, consentStatus },
                }),
            });
            if (res.ok) {
                setShowBankManual(false);
                setApiError(null);
            }
        } catch { setApiError('Failed to save bank details'); }
        finally { setSavingManual(false); }
    };

    // ── Comparison Table Helpers ───────────────────────────────────────────────

    const maskValue = (val: string | null | undefined, type: 'aadhaar' | 'pan' | 'account') => {
        if (!val) return null;
        if (type === 'aadhaar' && val.length >= 8) return 'XXXX XXXX ' + val.slice(-4);
        if (type === 'pan' && val.length >= 6) return val.slice(0, 2) + 'XXXX' + val.slice(-2);
        if (type === 'account' && val.length >= 4) return 'XXXXX' + val.slice(-4);
        return val;
    };

    const buildComparisonRows = () => {
        const rows: Array<{
            field: string; label: string;
            step1Value: string | null; ocrValue: string | null; manualValue: string | null;
            finalValue: string | null; matchStatus: 'match' | 'mismatch' | 'pending';
            source: string; remarks: string;
        }> = [];

        const allOcr: Record<string, any> = {};
        Object.values(uploadedDocs).forEach(doc => {
            if (doc.ocr_data) Object.assign(allOcr, doc.ocr_data);
        });

        const allManual: Record<string, string> = { ...manualFields };
        if (bankManualFields.account_holder_name) Object.assign(allManual, bankManualFields);

        const addRow = (field: string, label: string, step1Key: string | null, ocrKey: string | null, manualKey: string | null, mask?: 'aadhaar' | 'pan' | 'account') => {
            const s1 = step1Key && lead ? (lead[step1Key] || null) : null;
            const ocr = ocrKey ? (allOcr[ocrKey] || null) : null;
            const manual = manualKey ? (allManual[manualKey] || null) : null;
            const verified = ocr || manual;
            const finalVal = verified || s1;
            const displayS1 = mask ? maskValue(s1, mask) : s1;
            const displayOcr = mask ? maskValue(ocr, mask) : ocr;
            const displayManual = mask ? maskValue(manual, mask) : manual;
            const displayFinal = mask ? maskValue(finalVal, mask) : finalVal;

            let matchStatus: 'match' | 'mismatch' | 'pending' = 'pending';
            if (s1 && ocr) {
                matchStatus = s1.trim().toLowerCase() === ocr.trim().toLowerCase() ? 'match' : 'mismatch';
            } else if (s1 && manual) {
                matchStatus = s1.trim().toLowerCase() === manual.trim().toLowerCase() ? 'match' : 'mismatch';
            }

            let source = 'None';
            if (ocr) source = 'OCR/API';
            else if (manual) source = 'Manual';
            else if (s1) source = 'Step 1';

            rows.push({ field, label, step1Value: displayS1, ocrValue: displayOcr, manualValue: displayManual, finalValue: displayFinal, matchStatus, source, remarks: matchStatus === 'mismatch' ? 'Needs review' : '' });
        };

        addRow('full_name', 'Full Name', 'full_name', 'full_name', 'name');
        addRow('father_name', 'Father/Husband Name', 'father_or_husband_name', 'father_or_husband_name', 'father_name');
        addRow('dob', 'Date of Birth', 'dob', 'date_of_birth', 'dob');
        addRow('phone', 'Phone Number', 'phone', 'phone_number', null);
        addRow('address', 'Address', 'current_address', 'address', 'address');
        addRow('aadhaar_number', 'Aadhaar Number', null, 'aadhaar_number', 'aadhaar_number', 'aadhaar');
        addRow('pan_number', 'PAN Number', null, 'pan_number', 'pan_number', 'pan');
        addRow('bank_holder', 'Bank Account Holder', null, null, 'account_holder_name');
        addRow('account_number', 'Account Number', null, null, 'account_number', 'account');
        addRow('ifsc', 'IFSC', null, null, 'ifsc');

        return rows;
    };

    const getComparisonSummary = (rows: ReturnType<typeof buildComparisonRows>) => {
        const matched = rows.filter(r => r.matchStatus === 'match').length;
        const mismatched = rows.filter(r => r.matchStatus === 'mismatch').length;
        const pending = rows.filter(r => r.matchStatus === 'pending').length;
        return { matched, mismatched, pending };
    };

    // ── Consent ──────────────────────────────────────────────────────────────

    const handleSendConsent = async (channel: 'sms' | 'whatsapp') => {
        try {
            const res = await fetch(`/api/kyc/${leadId}/send-consent`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel }),
            });
            const data = await res.json();
            if (data.success) setConsentStatus('link_sent');
            else setApiError(data.error?.message || 'Failed to send consent');
        } catch { setApiError('Failed to send consent'); }
    };

    const handleUploadSignedConsent = async (file: File) => {
        if (file.type !== 'application/pdf' || file.size > 10 * 1024 * 1024) {
            setApiError('Only PDF files under 10MB are allowed'); return;
        }
        const formData = new FormData();
        formData.append('file', file);
        try {
            const res = await fetch(`/api/kyc/${leadId}/upload-signed-consent`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) setConsentStatus('manual_uploaded');
        } catch { setApiError('Upload failed'); }
    };

    const handleGenerateConsentPDF = async () => {
        try {
            const res = await fetch(`/api/kyc/${leadId}/generate-consent-pdf`, { method: 'POST' });
            const data = await res.json();
            if (data.success && data.pdfUrl) window.open(data.pdfUrl, '_blank');
        } catch { setApiError('Failed to generate PDF'); }
    };

    // ── Submit & Save ────────────────────────────────────────────────────────

    const handleSaveDraft = async (auto = false) => {
        setSaving(true);
        try {
            await fetch(`/api/kyc/${leadId}/save-draft`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ step: 2, data: { documents: uploadedDocs, consentStatus } }),
            });
            setLastSaved(auto ? `Auto-saved at ${new Date().toLocaleTimeString()}` : `Saved at ${new Date().toLocaleTimeString()}`);
        } catch { /* silent */ }
        finally { setSaving(false); }
    };

    const handleSubmitToSM = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/leads/${leadId}/submit-to-sm`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setSubmitted(true);
            } else {
                setApiError(data.error?.message || 'Failed to submit');
            }
        } catch { setApiError('Connection failed'); }
        finally { setSaving(false); }
    };

    const handleSaveAndNext = async () => {
        const stats = getDocStats();
        if (stats.uploaded < stats.total) { setApiError(`Missing: ${stats.pending.map(d => d.label).join(', ')}`); return; }
        if (!['digitally_signed', 'manual_uploaded', 'verified'].includes(consentStatus)) {
            setApiError('Customer consent is required'); return;
        }
        const failedVer = verifications.filter(v => v.status === 'failed');
        if (failedVer.length > 0) { setApiError(`Verification failures: ${failedVer.map(v => v.label).join(', ')}`); return; }

        setSaving(true);
        try {
            const res = await fetch(`/api/kyc/${leadId}/complete-and-next`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await res.json();
            if (data.success) {
                if (lead?.has_co_borrower) {
                    router.push(`/dealer-portal/leads/${leadId}/kyc/interim`);
                } else {
                    await handleSubmitToSM();
                }
            } else { setApiError(data.error?.message || 'Failed to proceed'); }
        } catch { setApiError('Connection failed'); }
        finally { setSaving(false); }
    };

    // ── Render ───────────────────────────────────────────────────────────────

    if (loading) return <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]"><Loader2 className="w-10 h-10 animate-spin text-[#1D4ED8]" /></div>;
    if (accessDenied) return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
            <div className="text-center">
                <Shield className="w-16 h-16 text-red-400 mx-auto mb-4" />
                <h2 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h2>
                <p className="text-gray-500 mb-6">KYC is only available for Hot leads.</p>
                <button onClick={() => router.push('/dealer-portal/leads')} className="px-6 py-3 bg-[#0047AB] text-white rounded-xl font-bold">Back to Leads</button>
            </div>
        </div>
    );

    const requiredDocs = getRequiredDocs();
    const docStats = getDocStats();

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1200px] mx-auto px-6 py-8 pb-40">
                {/* HEADER */}
                <header className="mb-8 flex justify-between items-start">
                    <div className="flex gap-4">
                        <button onClick={() => router.back()} className="mt-1 p-2 hover:bg-white transition-colors rounded-lg">
                            <ChevronLeft className="w-6 h-6 text-gray-900" />
                        </button>
                        <div>
                            <h1 className="text-[28px] font-black text-gray-900 leading-tight tracking-tight">Customer KYC</h1>
                            <p className="text-sm text-gray-500 mt-0.5">
                                Lead: <span className="font-medium">{lead?.reference_id || leadId}</span>
                                {lead?.full_name && <span> &mdash; {lead.full_name}</span>}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <div>
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest text-right mb-1.5">Workflow Progress</p>
                            <div className="flex items-center gap-6">
                                <span className="text-xs font-bold text-[#1D4ED8] whitespace-nowrap">Step 2 of 5</span>
                                <div className="flex gap-2.5">
                                    {[1, 2, 3, 4, 5].map(s => (
                                        <div key={s} className={`h-[6px] w-[50px] rounded-full transition-all duration-300 ${s <= 2 ? 'bg-[#0047AB]' : 'bg-gray-200'}`} />
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </header>

                {/* Step 2 Sub-Progress */}
                <div className="mb-6 flex items-center gap-2 overflow-x-auto pb-1">
                    {[
                        { label: 'Documents', done: docStats.uploaded === docStats.total, active: docStats.uploaded < docStats.total },
                        { label: 'Consent', done: ['digitally_signed', 'manual_uploaded', 'verified'].includes(consentStatus), active: docStats.uploaded === docStats.total },
                        { label: 'Review', done: false, active: false },
                    ].map((s, i) => (
                        <div key={s.label} className="flex items-center gap-2">
                            {i > 0 && <div className={`w-8 h-[2px] ${s.done || s.active ? 'bg-[#0047AB]' : 'bg-gray-200'}`} />}
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap ${
                                s.done ? 'bg-green-50 text-green-700 border border-green-200'
                                    : s.active ? 'bg-blue-50 text-[#0047AB] border border-blue-200'
                                        : 'bg-gray-50 text-gray-400 border border-gray-100'
                            }`}>
                                {s.done ? <CheckCircle2 className="w-3.5 h-3.5" /> : s.active ? <div className="w-2 h-2 bg-[#0047AB] rounded-full animate-pulse" /> : <div className="w-2 h-2 bg-gray-300 rounded-full" />}
                                {s.label}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Error Banner */}
                {apiError && (
                    <div className="mb-6 bg-red-50 border border-red-200 p-4 rounded-xl flex items-center justify-between">
                        <div className="flex items-center gap-3 text-red-700 font-medium text-sm">
                            <AlertCircle className="w-5 h-5" />
                            {apiError}
                        </div>
                        <button onClick={() => setApiError(null)} className="p-1 hover:bg-white rounded-md"><X className="w-5 h-5" /></button>
                    </div>
                )}

                {/* Submitted Banner */}
                {submitted && (
                    <div className="mb-6 bg-green-50 border border-green-200 p-6 rounded-xl text-center">
                        <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto mb-3" />
                        <p className="text-lg font-bold text-green-800">Submitted to Itarang Team</p>
                        <p className="text-sm text-green-600 mt-1">Our sales manager will review your documents and get back to you.</p>
                        <button onClick={() => router.push('/dealer-portal/leads')} className="mt-4 px-6 py-2 bg-[#0047AB] text-white rounded-xl font-bold text-sm">Back to Leads</button>
                    </div>
                )}

                <main className="grid grid-cols-1 gap-6">

                    {/* ═══════════════════════════════════════════════════════════
                        SECTION 2: DOCUMENT UPLOAD
                       ═══════════════════════════════════════════════════════════ */}
                    <SectionCard
                        title="Document Upload"
                        icon={<FileText className="w-5 h-5 text-[#0047AB]" />}
                    >
                        <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-4">
                                <div className="text-sm font-bold text-gray-900">
                                    Documents: <span className="text-[#0047AB]">{docStats.uploaded}/{docStats.total}</span>
                                </div>
                                <div className="h-2 w-40 bg-gray-100 rounded-full overflow-hidden">
                                    <div className="h-full bg-[#0047AB] rounded-full transition-all" style={{ width: `${docStats.total > 0 ? (docStats.uploaded / docStats.total) * 100 : 0}%` }} />
                                </div>
                            </div>
                            {docStats.pending.length > 0 && (
                                <p className="text-xs font-medium text-red-500">
                                    Pending: {docStats.pending.map(d => d.label).join(', ')}
                                </p>
                            )}
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                            {requiredDocs.map(doc => {
                                const uploaded = uploadedDocs[doc.key];
                                return (
                                    <DocumentCard
                                        key={doc.key}
                                        label={doc.label}
                                        required={doc.required}
                                        uploaded={!!uploaded?.file_url}
                                        verificationStatus={uploaded?.verification_status}
                                        failedReason={uploaded?.failed_reason}
                                        ocrFailed={uploaded?.ocr_failed}
                                        uploading={uploaded?.verification_status === 'initiating' && !uploaded?.file_url}
                                        onUpload={(file) => handleDocUpload(doc.key, file)}
                                        onManualEntry={() => setManualEntryDoc(doc.key)}
                                    />
                                );
                            })}
                        </div>
                    </SectionCard>

                    {/* ═══════════════════════════════════════════════════════════
                        SECTION 3: OCR COMPARISON RESULTS
                       ═══════════════════════════════════════════════════════════ */}
                    {Object.keys(ocrComparisons).length > 0 && (
                        <SectionCard title="Document Verification Results" icon={<Eye className="w-5 h-5 text-[#0047AB]" />}>
                            <p className="text-xs text-gray-400 mb-4">Extracted data compared with lead details. Mismatches highlighted in red.</p>
                            <div className="space-y-4">
                                {Object.entries(ocrComparisons).map(([docKey, comparisons]) => (
                                    <div key={docKey} className="p-4 bg-gray-50 rounded-xl">
                                        <h4 className="text-sm font-bold text-gray-900 mb-3 capitalize">
                                            {docKey.replace(/_/g, ' ')} - OCR Results
                                        </h4>
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="border-b border-gray-200">
                                                        <th className="text-left py-2 px-3 text-xs font-bold text-gray-500 uppercase">Field</th>
                                                        <th className="text-left py-2 px-3 text-xs font-bold text-gray-500 uppercase">From Document (OCR)</th>
                                                        <th className="text-left py-2 px-3 text-xs font-bold text-gray-500 uppercase">From Lead (Step 1)</th>
                                                        <th className="text-left py-2 px-3 text-xs font-bold text-gray-500 uppercase">Match</th>
                                                        <th className="text-left py-2 px-3 text-xs font-bold text-gray-500 uppercase">Similarity</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {comparisons.map(c => (
                                                        <tr key={c.field} className={`border-b border-gray-100 ${!c.match ? 'bg-red-50' : 'bg-green-50'}`}>
                                                            <td className="py-2 px-3 font-medium text-gray-900">{c.label}</td>
                                                            <td className="py-2 px-3 text-gray-700 font-mono text-xs">{c.ocrValue || <span className="text-gray-300 italic">Not found</span>}</td>
                                                            <td className="py-2 px-3 text-gray-700 font-mono text-xs">{c.leadValue || <span className="text-gray-300 italic">Not filled</span>}</td>
                                                            <td className="py-2 px-3">
                                                                {c.match
                                                                    ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700">Match</span>
                                                                    : <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700">Mismatch</span>
                                                                }
                                                            </td>
                                                            <td className="py-2 px-3 text-xs font-bold">
                                                                {c.similarity != null ? (
                                                                    <span className={c.similarity >= 80 ? 'text-green-600' : c.similarity >= 50 ? 'text-amber-600' : 'text-red-600'}>
                                                                        {c.similarity}%
                                                                    </span>
                                                                ) : '-'}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </SectionCard>
                    )}

                    {/* ═══════════════════════════════════════════════════════════
                        SECTION 4: MANUAL ENTRY FALLBACK (Document + Bank)
                       ═══════════════════════════════════════════════════════════ */}
                    {(manualEntryDoc || showBankManual) && (
                        <SectionCard title="Manual Data Entry" icon={<FileText className="w-5 h-5 text-amber-500" />}>
                            {/* Tabs */}
                            {manualEntryDoc && (
                                <div className="flex gap-2 mb-4">
                                    <button onClick={() => setManualEntryTab('document')}
                                        className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${manualEntryTab === 'document' ? 'bg-[#0047AB] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                                        Document Details
                                    </button>
                                    <button onClick={() => { setManualEntryTab('bank'); setShowBankManual(true); }}
                                        className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${manualEntryTab === 'bank' ? 'bg-[#0047AB] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                                        <Landmark className="w-3 h-3 inline mr-1" /> Bank Details
                                    </button>
                                </div>
                            )}

                            {/* Document Manual Entry */}
                            {manualEntryTab === 'document' && manualEntryDoc && (
                                <>
                                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl mb-4">
                                        <div className="flex items-center gap-2 text-amber-700 text-sm font-medium mb-1">
                                            <AlertCircle className="w-4 h-4" />
                                            OCR could not extract data from <strong className="capitalize">{manualEntryDoc.replace(/_/g, ' ')}</strong>
                                        </div>
                                        <p className="text-xs text-amber-600">Please enter the details manually from the document.</p>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {(manualEntryDoc.includes('aadhaar') || manualEntryDoc.includes('pan')) && (
                                            <>
                                                <InputField label="Full Name (as on document)" value={manualFields.name} onChange={v => setManualFields(p => ({ ...p, name: v }))} placeholder="Full name as printed" />
                                                <InputField label="Father/Husband Name" value={manualFields.father_name} onChange={v => setManualFields(p => ({ ...p, father_name: v }))} placeholder="Father or husband name" />
                                                <InputField label="Date of Birth" type="date" value={manualFields.dob} onChange={v => setManualFields(p => ({ ...p, dob: v }))} />
                                            </>
                                        )}
                                        {manualEntryDoc.includes('aadhaar') && (
                                            <>
                                                <div className="space-y-1">
                                                    <label className="text-xs font-bold text-gray-700">Aadhaar Number</label>
                                                    <input
                                                        value={manualFields.aadhaar_number}
                                                        onChange={e => setManualFields(p => ({ ...p, aadhaar_number: e.target.value.replace(/\D/g, '').slice(0, 12) }))}
                                                        placeholder="12-digit Aadhaar" maxLength={12}
                                                        className="w-full h-10 px-3 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm font-mono outline-none focus:border-[#1D4ED8]"
                                                    />
                                                    {manualFields.aadhaar_number && manualFields.aadhaar_number.length !== 12 && (
                                                        <p className="text-[10px] text-red-500 font-bold">Must be exactly 12 digits</p>
                                                    )}
                                                </div>
                                                <div className="space-y-1 md:col-span-2">
                                                    <label className="text-xs font-bold text-gray-700">Address</label>
                                                    <textarea
                                                        value={manualFields.address}
                                                        onChange={e => setManualFields(p => ({ ...p, address: e.target.value }))}
                                                        className="w-full h-20 px-3 py-2 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] resize-none"
                                                        placeholder="Full address as on Aadhaar"
                                                    />
                                                </div>
                                            </>
                                        )}
                                        {manualEntryDoc.includes('pan') && (
                                            <div className="space-y-1">
                                                <label className="text-xs font-bold text-gray-700">PAN Number</label>
                                                <input
                                                    value={manualFields.pan_number}
                                                    onChange={e => setManualFields(p => ({ ...p, pan_number: e.target.value.toUpperCase().slice(0, 10) }))}
                                                    placeholder="ABCDE1234F" maxLength={10}
                                                    className="w-full h-10 px-3 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm font-mono uppercase outline-none focus:border-[#1D4ED8]"
                                                />
                                                {manualFields.pan_number && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(manualFields.pan_number) && (
                                                    <p className="text-[10px] text-red-500 font-bold">Invalid PAN format (e.g. ABCDE1234F)</p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex justify-end gap-3 mt-4">
                                        <button onClick={() => { setManualEntryDoc(null); setManualFields({ name: '', father_name: '', dob: '', address: '', pan_number: '', aadhaar_number: '' }); }}
                                            className="px-6 py-2 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
                                        <button onClick={handleSaveManualEntry} disabled={savingManual || !manualFields.name}
                                            className="px-6 py-2 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2">
                                            {savingManual ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                            Save Manual Entry
                                        </button>
                                    </div>
                                </>
                            )}

                            {/* Bank Manual Entry */}
                            {(manualEntryTab === 'bank' || (!manualEntryDoc && showBankManual)) && (
                                <>
                                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl mb-4">
                                        <div className="flex items-center gap-2 text-blue-700 text-sm font-medium">
                                            <Landmark className="w-4 h-4" />
                                            Enter bank account details for verification
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <InputField label="Account Holder Name *" value={bankManualFields.account_holder_name}
                                            onChange={v => setBankManualFields(p => ({ ...p, account_holder_name: v }))} placeholder="Name as per bank records" error={bankManualErrors.account_holder_name} />
                                        <div className="space-y-1">
                                            <label className="text-xs font-bold text-gray-700">Account Type</label>
                                            <select value={bankManualFields.account_type}
                                                onChange={e => setBankManualFields(p => ({ ...p, account_type: e.target.value }))}
                                                className="w-full h-10 px-3 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]">
                                                <option value="savings">Savings</option>
                                                <option value="current">Current</option>
                                            </select>
                                        </div>
                                        <InputField label="Account Number *" value={bankManualFields.account_number}
                                            onChange={v => setBankManualFields(p => ({ ...p, account_number: v.replace(/\D/g, '') }))} placeholder="Account number" mono error={bankManualErrors.account_number} />
                                        <InputField label="Confirm Account Number *" value={bankManualFields.confirm_account_number}
                                            onChange={v => setBankManualFields(p => ({ ...p, confirm_account_number: v.replace(/\D/g, '') }))} placeholder="Re-enter account number" mono error={bankManualErrors.confirm_account_number} />
                                        <InputField label="IFSC Code *" value={bankManualFields.ifsc}
                                            onChange={v => setBankManualFields(p => ({ ...p, ifsc: v.toUpperCase().slice(0, 11) }))} placeholder="e.g. SBIN0001234" mono upper error={bankManualErrors.ifsc} />
                                        <InputField label="Bank Name *" value={bankManualFields.bank_name}
                                            onChange={v => setBankManualFields(p => ({ ...p, bank_name: v }))} placeholder="e.g. State Bank of India" error={bankManualErrors.bank_name} />
                                        <InputField label="Branch (optional)" value={bankManualFields.branch}
                                            onChange={v => setBankManualFields(p => ({ ...p, branch: v }))} placeholder="Branch name" />
                                    </div>
                                    <div className="flex justify-end gap-3 mt-4">
                                        <button onClick={() => { setShowBankManual(false); if (manualEntryDoc) setManualEntryTab('document'); }}
                                            className="px-6 py-2 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
                                        <button onClick={handleSaveBankManual} disabled={savingManual}
                                            className="px-6 py-2 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2">
                                            {savingManual ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                            Save Bank Details
                                        </button>
                                    </div>
                                </>
                            )}
                        </SectionCard>
                    )}

                    {/* ═══════════════════════════════════════════════════════════
                        SECTION 6: CUSTOMER CONSENT
                       ═══════════════════════════════════════════════════════════ */}
                    <SectionCard title="Customer Consent" icon={<FileText className="w-5 h-5 text-[#0047AB]" />}>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="space-y-3">
                                <h4 className="text-sm font-bold text-gray-900">Digital Consent</h4>
                                <button onClick={() => handleSendConsent('sms')} disabled={consentStatus !== 'awaiting_signature'}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 hover:bg-[#003580] transition-all">
                                    <Send className="w-4 h-4" /> Send SMS Consent
                                </button>
                                <button onClick={() => handleSendConsent('whatsapp')} disabled={consentStatus !== 'awaiting_signature'}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-xl text-sm font-bold disabled:opacity-40 hover:bg-green-700 transition-all">
                                    <Send className="w-4 h-4" /> Send WhatsApp Consent
                                </button>
                            </div>
                            <div className="space-y-3">
                                <h4 className="text-sm font-bold text-gray-900">Manual Consent</h4>
                                <button onClick={handleGenerateConsentPDF}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-gray-200 rounded-xl text-sm font-bold hover:border-[#0047AB] transition-all">
                                    <Download className="w-4 h-4" /> Generate Consent PDF
                                </button>
                                <label className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-200 rounded-xl text-sm font-bold cursor-pointer hover:border-[#0047AB] transition-all">
                                    <Upload className="w-4 h-4" /> Upload Signed PDF
                                    <input type="file" className="hidden" accept="application/pdf" onChange={e => e.target.files?.[0] && handleUploadSignedConsent(e.target.files[0])} />
                                </label>
                            </div>
                            <div className="space-y-3">
                                <h4 className="text-sm font-bold text-gray-900">Status</h4>
                                <div className="p-4 bg-gray-50 rounded-xl space-y-2">
                                    {['awaiting_signature', 'link_sent', 'digitally_signed', 'manual_uploaded', 'verified'].map(s => (
                                        <div key={s} className="flex items-center gap-2">
                                            {consentStatus === s || (['digitally_signed', 'manual_uploaded', 'verified'].includes(consentStatus) && ['awaiting_signature', 'link_sent'].includes(s))
                                                ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                                                : <div className="w-4 h-4 rounded-full border-2 border-gray-200" />}
                                            <span className={`text-xs font-medium ${consentStatus === s ? 'text-gray-900' : 'text-gray-400'}`}>
                                                {s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </SectionCard>

                    {/* ═══════════════════════════════════════════════════════════
                        SECTION 7: VERIFICATION STATUS TABLE
                       ═══════════════════════════════════════════════════════════ */}
                    {verifications.length > 0 && (
                        <SectionCard title="Verification Status" icon={<Shield className="w-5 h-5 text-[#0047AB]" />}>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-gray-100">
                                            <th className="text-left py-3 px-4 font-bold text-gray-500 text-xs uppercase">Check</th>
                                            <th className="text-left py-3 px-4 font-bold text-gray-500 text-xs uppercase">Status</th>
                                            <th className="text-left py-3 px-4 font-bold text-gray-500 text-xs uppercase">Last Update</th>
                                            <th className="text-left py-3 px-4 font-bold text-gray-500 text-xs uppercase">Action</th>
                                            <th className="text-left py-3 px-4 font-bold text-gray-500 text-xs uppercase">Reason</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {verifications.map(v => (
                                            <tr key={v.type} className="border-b border-gray-50 hover:bg-gray-50/50">
                                                <td className="py-3 px-4 font-medium text-gray-900">{v.label}</td>
                                                <td className="py-3 px-4"><StatusBadge status={v.status} /></td>
                                                <td className="py-3 px-4 text-gray-500 text-xs">{v.last_update || '-'}</td>
                                                <td className="py-3 px-4">
                                                    {v.status === 'failed' && (
                                                        <label className="flex items-center gap-1 text-xs font-bold text-[#0047AB] cursor-pointer hover:underline">
                                                            <RefreshCw className="w-3 h-3" /> Re-upload
                                                            <input type="file" className="hidden" accept="image/*,application/pdf"
                                                                onChange={async e => {
                                                                    if (!e.target.files?.[0]) return;
                                                                    const formData = new FormData();
                                                                    formData.append('file', e.target.files[0]);
                                                                    formData.append('verificationType', v.type);
                                                                    try {
                                                                        const res = await fetch(`/api/kyc/${leadId}/re-upload`, { method: 'POST', body: formData });
                                                                        const data = await res.json();
                                                                        if (data.success) setVerifications(prev => prev.map(x => x.type === v.type ? { ...x, status: 'awaiting_action', failed_reason: null } : x));
                                                                    } catch { setApiError('Re-upload failed'); }
                                                                }} />
                                                        </label>
                                                    )}
                                                </td>
                                                <td className="py-3 px-4 text-red-500 text-xs">{v.failed_reason || '-'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </SectionCard>
                    )}

                    {/* ═══════════════════════════════════════════════════════════
                        SECTION 8: COMPARISON + VALIDATION TABLE
                       ═══════════════════════════════════════════════════════════ */}
                    {(Object.keys(uploadedDocs).length > 0 || Object.keys(manualFields).some(k => manualFields[k]) || bankManualFields.account_holder_name) && (() => {
                        const rows = buildComparisonRows();
                        const summary = getComparisonSummary(rows);
                        const hasData = rows.some(r => r.step1Value || r.ocrValue || r.manualValue);
                        if (!hasData) return null;
                        return (
                            <SectionCard title="Comparison & Validation Summary" icon={<Table2 className="w-5 h-5 text-[#0047AB]" />}>
                                {/* Summary badges */}
                                <div className="flex gap-4 mb-4">
                                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 border border-green-200 rounded-full text-xs font-bold text-green-700">
                                        <CheckCircle2 className="w-3.5 h-3.5" /> {summary.matched} Matched
                                    </div>
                                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border border-red-200 rounded-full text-xs font-bold text-red-700">
                                        <XCircle className="w-3.5 h-3.5" /> {summary.mismatched} Mismatched
                                    </div>
                                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-full text-xs font-bold text-gray-500">
                                        <Clock className="w-3.5 h-3.5" /> {summary.pending} Pending
                                    </div>
                                </div>

                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b-2 border-gray-200">
                                                <th className="text-left py-2.5 px-3 text-[10px] font-black text-gray-500 uppercase">Field</th>
                                                <th className="text-left py-2.5 px-3 text-[10px] font-black text-gray-500 uppercase">Step 1 Value</th>
                                                <th className="text-left py-2.5 px-3 text-[10px] font-black text-gray-500 uppercase">OCR / API</th>
                                                <th className="text-left py-2.5 px-3 text-[10px] font-black text-gray-500 uppercase">Manual</th>
                                                <th className="text-left py-2.5 px-3 text-[10px] font-black text-gray-500 uppercase">Final Value</th>
                                                <th className="text-left py-2.5 px-3 text-[10px] font-black text-gray-500 uppercase">Status</th>
                                                <th className="text-left py-2.5 px-3 text-[10px] font-black text-gray-500 uppercase">Source</th>
                                                <th className="text-left py-2.5 px-3 text-[10px] font-black text-gray-500 uppercase">Remarks</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.map(r => (
                                                <tr key={r.field} className={`border-b border-gray-50 ${
                                                    r.matchStatus === 'mismatch' ? 'bg-red-50/50' : r.matchStatus === 'match' ? 'bg-green-50/30' : ''
                                                }`}>
                                                    <td className="py-2.5 px-3 font-medium text-gray-900 text-xs">{r.label}</td>
                                                    <td className="py-2.5 px-3 text-gray-700 font-mono text-[11px]">{r.step1Value || <span className="text-gray-300 italic">-</span>}</td>
                                                    <td className="py-2.5 px-3 text-gray-700 font-mono text-[11px]">{r.ocrValue || <span className="text-gray-300 italic">-</span>}</td>
                                                    <td className="py-2.5 px-3 text-gray-700 font-mono text-[11px]">{r.manualValue || <span className="text-gray-300 italic">-</span>}</td>
                                                    <td className="py-2.5 px-3 text-gray-900 font-mono text-[11px] font-bold">{r.finalValue || <span className="text-gray-300 italic">-</span>}</td>
                                                    <td className="py-2.5 px-3">
                                                        {r.matchStatus === 'match' ? (
                                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-green-100 text-green-700">Match</span>
                                                        ) : r.matchStatus === 'mismatch' ? (
                                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-red-100 text-red-700">Mismatch</span>
                                                        ) : (
                                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-gray-100 text-gray-500">Pending</span>
                                                        )}
                                                    </td>
                                                    <td className="py-2.5 px-3 text-gray-500 text-[11px]">{r.source}</td>
                                                    <td className="py-2.5 px-3 text-xs">
                                                        {r.remarks && <span className="text-amber-600 font-medium">{r.remarks}</span>}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </SectionCard>
                        );
                    })()}
                </main>

                {/* ═══════════════════════════════════════════════════════════
                    STICKY FOOTER
                   ═══════════════════════════════════════════════════════════ */}
                <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
                    <div className="max-w-[1200px] mx-auto px-6 py-4 flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <button onClick={() => router.push('/dealer-portal/leads')}
                                className="px-5 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50 flex items-center gap-2">
                                <ChevronLeft className="w-4 h-4" /> Back
                            </button>
                            {lastSaved && <span className="text-xs text-gray-400">{lastSaved}</span>}
                            <button onClick={() => handleSaveDraft(false)} disabled={saving}
                                className="px-5 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40 flex items-center gap-2">
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                                Save Draft
                            </button>
                        </div>
                        <div className="flex items-center gap-3">
                            <button onClick={handleSaveAndNext} disabled={saving || submitted}
                                className="px-8 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 hover:bg-[#003580] flex items-center gap-2">
                                Save & Next <ArrowRight className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── Sub-Components ───────────────────────────────────────────────────────────

function SectionCard({ title, icon, children, disabled, disabledMessage }: {
    title: string; icon?: React.ReactNode; children: React.ReactNode;
    disabled?: boolean; disabledMessage?: string;
}) {
    return (
        <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden ${disabled ? 'opacity-50' : ''}`}>
            <div className="px-6 py-4 border-b border-gray-50 flex items-center gap-3">
                {icon}
                <h3 className="text-base font-black text-gray-900">{title}</h3>
            </div>
            <div className="px-6 py-5 relative">
                {disabled && (
                    <div className="absolute inset-0 bg-white/60 z-10 flex items-center justify-center">
                        <div className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-bold">
                            {disabledMessage || 'Section locked'}
                        </div>
                    </div>
                )}
                {children}
            </div>
        </div>
    );
}

function DocumentCard({ label, required, uploaded, verificationStatus, failedReason, ocrFailed, uploading, onUpload, onManualEntry }: {
    label: string; required: boolean; uploaded: boolean;
    verificationStatus?: VerificationStatus; failedReason?: string;
    ocrFailed?: boolean; uploading?: boolean;
    onUpload: (file: File) => void; onManualEntry: () => void;
}) {
    return (
        <div className={`p-4 rounded-xl border-2 transition-all ${
            uploaded && verificationStatus === 'in_progress' ? 'border-green-200 bg-green-50/50'
                : uploaded && verificationStatus === 'failed' ? 'border-red-200 bg-red-50/50'
                    : uploaded ? 'border-blue-200 bg-blue-50/50'
                        : 'border-dashed border-gray-200 hover:border-[#0047AB]'
        }`}>
            <div className="flex items-start justify-between mb-3">
                <span className="text-xs font-bold text-gray-900">{label}</span>
                {required && <span className="text-[9px] font-bold text-red-500 uppercase">Required</span>}
            </div>

            {uploading ? (
                <div className="flex flex-col items-center py-4">
                    <Loader2 className="w-6 h-6 animate-spin text-[#0047AB] mb-2" />
                    <span className="text-[10px] text-gray-400">Uploading...</span>
                </div>
            ) : uploaded ? (
                <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                        {verificationStatus === 'in_progress' ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                            : verificationStatus === 'failed' ? <XCircle className="w-4 h-4 text-red-500" />
                                : <Clock className="w-4 h-4 text-amber-500" />}
                        <span className="text-[10px] font-bold text-gray-600 capitalize">{verificationStatus?.replace(/_/g, ' ')}</span>
                    </div>
                    {failedReason && <p className="text-[10px] text-red-500 line-clamp-2">{failedReason}</p>}
                    <div className="flex gap-2">
                        <label className="text-[10px] font-bold text-[#0047AB] cursor-pointer hover:underline flex items-center gap-0.5">
                            <RefreshCw className="w-3 h-3" /> Re-upload
                            <input type="file" className="hidden" accept="image/*,application/pdf" onChange={e => e.target.files?.[0] && onUpload(e.target.files[0])} />
                        </label>
                        {ocrFailed && (
                            <button onClick={onManualEntry} className="text-[10px] font-bold text-amber-600 hover:underline flex items-center gap-0.5">
                                <FileText className="w-3 h-3" /> Manual
                            </button>
                        )}
                    </div>
                </div>
            ) : (
                <label className="flex flex-col items-center py-4 cursor-pointer group">
                    <Upload className="w-6 h-6 text-gray-300 group-hover:text-[#0047AB] transition-colors mb-2" />
                    <span className="text-[10px] font-bold text-gray-400 group-hover:text-[#0047AB]">Click to upload</span>
                    <span className="text-[9px] text-gray-300 mt-0.5">PNG, JPEG, PDF (max 5MB)</span>
                    <input type="file" className="hidden" accept="image/*,application/pdf" onChange={e => e.target.files?.[0] && onUpload(e.target.files[0])} />
                </label>
            )}
        </div>
    );
}

function StatusBadge({ status }: { status: VerificationStatus }) {
    const cfg: Record<string, { bg: string; text: string; label: string }> = {
        pending: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Pending' },
        initiating: { bg: 'bg-blue-50', text: 'text-blue-600', label: 'Initiating' },
        awaiting_action: { bg: 'bg-amber-50', text: 'text-amber-600', label: 'Awaiting' },
        in_progress: { bg: 'bg-blue-50', text: 'text-blue-600', label: 'In Progress' },
        success: { bg: 'bg-green-50', text: 'text-green-600', label: 'Success' },
        failed: { bg: 'bg-red-50', text: 'text-red-600', label: 'Failed' },
    };
    const c = cfg[status] || cfg.pending;
    return <span className={`px-3 py-1 rounded-full text-[10px] font-bold ${c.bg} ${c.text}`}>{c.label}</span>;
}

function InputField({ label, value, onChange, placeholder, type = 'text', maxLength, mono, upper, error }: {
    label: string; value: string; onChange: (v: string) => void;
    placeholder?: string; type?: string; maxLength?: number; mono?: boolean; upper?: boolean; error?: string;
}) {
    return (
        <div className="space-y-1">
            <label className="text-xs font-bold text-gray-700">{label}</label>
            <input
                type={type} value={value} onChange={e => onChange(upper ? e.target.value.toUpperCase() : e.target.value)}
                placeholder={placeholder} maxLength={maxLength}
                className={`w-full h-10 px-3 bg-white border-2 rounded-xl text-sm outline-none focus:border-[#1D4ED8] ${mono ? 'font-mono' : ''} ${upper ? 'uppercase' : ''} ${error ? 'border-red-400' : 'border-[#EBEBEB]'}`}
            />
            {error && <p className="text-[10px] text-red-500 font-bold">{error}</p>}
        </div>
    );
}
