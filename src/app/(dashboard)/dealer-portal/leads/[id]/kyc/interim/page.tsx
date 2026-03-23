'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
    ChevronLeft, Loader2, Upload, CheckCircle2, XCircle,
    AlertCircle, Clock, X, Send, Download, Shield,
    RefreshCw, ChevronRight, Plus, User, FileText, Scan, Camera
} from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';

const CO_BORROWER_DOCS = [
    { key: 'aadhaar_front', label: 'Aadhaar Front', required: true },
    { key: 'aadhaar_back', label: 'Aadhaar Back', required: true },
    { key: 'pan_card', label: 'PAN Card', required: true },
    { key: 'passport_photo', label: 'Passport Photo', required: true },
    { key: 'address_proof', label: 'Address Proof', required: false },
    { key: 'bank_statement', label: 'Bank Statement', required: false },
    { key: 'cheque_1', label: 'Undated Cheque 1', required: false },
    { key: 'cheque_2', label: 'Undated Cheque 2', required: false },
    { key: 'cheque_3', label: 'Undated Cheque 3', required: false },
    { key: 'cheque_4', label: 'Undated Cheque 4', required: false },
    { key: 'rc_copy', label: 'RC Copy', required: false },
];

type VerificationStatus = 'pending' | 'initiating' | 'awaiting_action' | 'in_progress' | 'success' | 'failed';

export default function InterimStepPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [apiError, setApiError] = useState<string | null>(null);
    const [lastSaved, setLastSaved] = useState<string | null>(null);

    // Co-borrower state
    const [hasCoBorrower, setHasCoBorrower] = useState(false);
    const [coBorrowerForm, setCoBorrowerForm] = useState({
        full_name: '', father_or_husband_name: '', dob: '', phone: '',
        permanent_address: '', current_address: '', is_current_same: false,
        pan_no: '', aadhaar_no: '',
    });
    const [coBorrowerDocs, setCoBorrowerDocs] = useState<Record<string, { file_url: string; status: VerificationStatus }>>({});
    const [coBorrowerVerifications, setCoBorrowerVerifications] = useState<any[]>([]);
    const [coBorrowerConsentStatus, setCoBorrowerConsentStatus] = useState('awaiting_signature');

    // Other documents state
    const [otherDocRequests, setOtherDocRequests] = useState<any[]>([]);
    const [otherDocsStatus, setOtherDocsStatus] = useState<string>('pending');

    const [submitted, setSubmitted] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    // OCR modal
    const [showOCR, setShowOCR] = useState(false);

    useEffect(() => {
        const loadData = async () => {
            try {
                // Check access
                const accessRes = await fetch(`/api/coborrower/${leadId}/access-check`);
                const accessData = await accessRes.json();
                if (!accessData.success || !accessData.allowed) {
                    router.push(`/dealer-portal/leads/${leadId}/kyc`);
                    return;
                }

                setHasCoBorrower(accessData.has_co_borrower);

                // Load existing co-borrower data
                if (accessData.has_co_borrower) {
                    const cobRes = await fetch(`/api/coborrower/${leadId}`);
                    const cobData = await cobRes.json();
                    if (cobData.success && cobData.data) {
                        setCoBorrowerForm(cobData.data);
                    }

                    // Load co-borrower docs
                    const docsRes = await fetch(`/api/coborrower/${leadId}/documents`);
                    const docsData = await docsRes.json();
                    if (docsData.success) {
                        const docMap: Record<string, any> = {};
                        docsData.data.forEach((d: any) => {
                            docMap[d.doc_type] = { file_url: d.file_url, status: d.verification_status };
                        });
                        setCoBorrowerDocs(docMap);
                    }
                }

                // Load other document requests
                const otherRes = await fetch(`/api/coborrower/${leadId}/required-other-docs`);
                const otherData = await otherRes.json();
                if (otherData.success) {
                    setOtherDocRequests(otherData.data || []);
                }
            } catch (err) {
                setApiError('Failed to load data');
            } finally {
                setLoading(false);
            }
        };
        loadData();
    }, [leadId, router]);

    // Auto-save every 2 minutes
    useEffect(() => {
        const interval = setInterval(() => handleSaveDraft(true), 120000);
        return () => clearInterval(interval);
    }, [coBorrowerForm, coBorrowerDocs]);

    const updateCoBorrowerField = (field: string, value: any) => {
        setCoBorrowerForm(prev => {
            const next = { ...prev, [field]: value };
            if (field === 'is_current_same' && value) next.current_address = next.permanent_address;
            if (field === 'permanent_address' && next.is_current_same) next.current_address = value;
            return next;
        });
    };

    const handleCoBorrowerDocUpload = async (docType: string, file: File) => {
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
                setOtherDocRequests(prev => prev.map(d =>
                    d.doc_key === docKey ? { ...d, file_url: data.file_url, upload_status: 'uploaded' } : d
                ));
            }
        } catch { setApiError('Upload failed'); }
    };

    const handleSendCoBorrowerConsent = async (channel: 'sms' | 'whatsapp') => {
        try {
            const res = await fetch(`/api/coborrower/${leadId}/send-consent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel })
            });
            const data = await res.json();
            if (data.success) setCoBorrowerConsentStatus('link_sent');
        } catch { setApiError('Failed to send consent'); }
    };

    const handleSubmitToSM = async () => {
        const requiredUploaded = CO_BORROWER_DOCS.filter(d => d.required).every(d => coBorrowerDocs[d.key]?.file_url);
        if (!requiredUploaded) { setApiError('Please upload all required co-borrower documents'); return; }

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

    const handleSubmitOtherDocs = async () => {
        const allUploaded = otherDocRequests.filter(d => d.is_required).every(d => d.upload_status === 'uploaded');
        if (!allUploaded) { setApiError('Please upload all required documents'); return; }

        try {
            const res = await fetch(`/api/coborrower/${leadId}/submit-other-docs-review`, { method: 'POST' });
            const data = await res.json();
            if (data.success) setOtherDocsStatus('pending_review');
        } catch { setApiError('Submission failed'); }
    };

    const handleSaveDraft = async (auto = false) => {
        setSaving(true);
        try {
            await fetch(`/api/coborrower/${leadId}/save-draft`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ coBorrowerForm, coBorrowerDocs, coBorrowerConsentStatus, otherDocRequests })
            });
            const now = new Date().toLocaleTimeString();
            setLastSaved(auto ? `Auto-saved at ${now}` : `Saved at ${now}`);
        } catch { /* silent */ }
        finally { setSaving(false); }
    };

    const handlePreviewAndNext = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/coborrower/${leadId}/complete-and-preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            const data = await res.json();
            if (data.success) {
                router.push(`/dealer-portal/leads/${leadId}`); // Profile preview / Step 3
            } else {
                setApiError(data.error?.message || 'Failed to proceed');
            }
        } catch { setApiError('Connection failed'); }
        finally { setSaving(false); }
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]"><Loader2 className="w-10 h-10 animate-spin text-[#1D4ED8]" /></div>;

    const requiredCobDocs = CO_BORROWER_DOCS.filter(d => d.required);
    const cobDocsUploaded = requiredCobDocs.filter(d => coBorrowerDocs[d.key]?.file_url).length;

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
                            <h1 className="text-[28px] font-black text-gray-900 leading-tight tracking-tight">Co-Borrower KYC</h1>
                            <p className="text-sm text-gray-500 mt-0.5">Step 3 — Upload co-borrower documents</p>
                        </div>
                    </div>
                    <div>
                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest text-right mb-1.5">Workflow Progress</p>
                        <div className="flex items-center gap-6">
                            <span className="text-xs font-bold text-[#1D4ED8] whitespace-nowrap">Step 3 of 5</span>
                            <div className="flex gap-2.5">
                                {[1, 2, 3, 4, 5].map(s => (
                                    <div key={s} className={`h-[6px] w-[50px] rounded-full transition-all ${s <= 3 ? 'bg-[#0047AB]' : 'bg-gray-200'}`} />
                                ))}
                            </div>
                        </div>
                    </div>
                </header>

                {apiError && (
                    <div className="mb-6 bg-red-50 border border-red-200 p-4 rounded-xl flex items-center justify-between">
                        <div className="flex items-center gap-3 text-red-700 font-medium text-sm"><AlertCircle className="w-5 h-5" />{apiError}</div>
                        <button onClick={() => setApiError(null)} className="p-1 hover:bg-white rounded-md"><X className="w-5 h-5" /></button>
                    </div>
                )}

                <main className="grid grid-cols-1 gap-6">
                    {/* CO-BORROWER INFORMATION */}
                    {hasCoBorrower && (
                        <SectionCard title="Co-Borrower / Guarantor Information">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                                <FormInput label="Full Name *" value={coBorrowerForm.full_name} onChange={v => updateCoBorrowerField('full_name', v)} placeholder="John Doe" />
                                <FormInput label="Father/Husband Name" value={coBorrowerForm.father_or_husband_name} onChange={v => updateCoBorrowerField('father_or_husband_name', v)} placeholder="Richard Doe" />
                                <FormInput label="Date of Birth *" type="date" value={coBorrowerForm.dob} onChange={v => updateCoBorrowerField('dob', v)} />
                                <FormInput label="Phone *" value={coBorrowerForm.phone} onChange={v => updateCoBorrowerField('phone', v)} placeholder="+91 9876543210" />
                                <FormInput label="PAN Number" value={coBorrowerForm.pan_no} onChange={v => updateCoBorrowerField('pan_no', v.toUpperCase())} placeholder="ABCDE1234F" />
                                <FormInput label="Aadhaar Number" value={coBorrowerForm.aadhaar_no} onChange={v => updateCoBorrowerField('aadhaar_no', v)} placeholder="1234 5678 9012" />
                                <div className="md:col-span-2">
                                    <FormInput label="Permanent Address" value={coBorrowerForm.permanent_address} onChange={v => updateCoBorrowerField('permanent_address', v)} placeholder="Full address" />
                                </div>
                                <div className="md:col-span-2 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-bold text-gray-900 px-1">Current Address</label>
                                        <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-gray-600">
                                            <input type="checkbox" checked={coBorrowerForm.is_current_same} onChange={e => updateCoBorrowerField('is_current_same', e.target.checked)} className="rounded" />
                                            Same as permanent
                                        </label>
                                    </div>
                                    <input
                                        value={coBorrowerForm.current_address}
                                        disabled={coBorrowerForm.is_current_same}
                                        onChange={e => updateCoBorrowerField('current_address', e.target.value)}
                                        className={`w-full h-11 px-6 bg-white border-2 rounded-xl outline-none text-sm ${coBorrowerForm.is_current_same ? 'bg-gray-50 border-gray-100 text-gray-400' : 'border-[#EBEBEB] focus:border-[#1D4ED8]'}`}
                                        placeholder="Current address"
                                    />
                                </div>
                            </div>

                            <div className="mt-6">
                                <button onClick={() => setShowOCR(true)} className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-bold hover:border-[#1D4ED8] transition-all">
                                    <Scan className="w-4 h-4" /> Auto-fill from Aadhaar
                                </button>
                            </div>
                        </SectionCard>
                    )}

                    {/* CO-BORROWER DOCUMENTS */}
                    {hasCoBorrower && (
                        <SectionCard title="Co-Borrower Document Upload">
                            <div className="flex items-center gap-4 mb-6">
                                <span className="text-sm font-bold text-gray-900">
                                    Documents: <span className="text-[#0047AB]">{cobDocsUploaded}/{requiredCobDocs.length}</span> required uploaded
                                </span>
                                <div className="h-2 w-40 bg-gray-100 rounded-full overflow-hidden">
                                    <div className="h-full bg-[#0047AB] rounded-full transition-all" style={{ width: `${(cobDocsUploaded / requiredCobDocs.length) * 100}%` }} />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                                {CO_BORROWER_DOCS.map(doc => (
                                    <DocumentCard
                                        key={doc.key}
                                        label={doc.label}
                                        required={doc.required}
                                        uploaded={!!coBorrowerDocs[doc.key]?.file_url}
                                        status={coBorrowerDocs[doc.key]?.status}
                                        onUpload={file => handleCoBorrowerDocUpload(doc.key, file)}
                                    />
                                ))}
                            </div>
                        </SectionCard>
                    )}

                    {/* CO-BORROWER CONSENT */}
                    {hasCoBorrower && (
                        <SectionCard title="Co-Borrower Consent">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <button onClick={() => handleSendCoBorrowerConsent('sms')} disabled={coBorrowerConsentStatus !== 'awaiting_signature'} className="flex items-center justify-center gap-2 px-4 py-3 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40">
                                    <Send className="w-4 h-4" /> Send SMS Consent
                                </button>
                                <button onClick={() => handleSendCoBorrowerConsent('whatsapp')} disabled={coBorrowerConsentStatus !== 'awaiting_signature'} className="flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-xl text-sm font-bold disabled:opacity-40">
                                    <Send className="w-4 h-4" /> Send WhatsApp Consent
                                </button>
                            </div>
                            <div className={`mt-4 px-4 py-2 rounded-lg text-xs font-bold ${coBorrowerConsentStatus === 'link_sent' ? 'bg-amber-50 text-amber-700' : coBorrowerConsentStatus === 'digitally_signed' || coBorrowerConsentStatus === 'manual_uploaded' ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-500'}`}>
                                Consent Status: {coBorrowerConsentStatus.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                            </div>
                        </SectionCard>
                    )}

                    {/* SUBMIT TO SM */}
                    {submitted && (
                        <div className="p-8 bg-green-50 border border-green-200 rounded-2xl text-center">
                            <CheckCircle2 className="w-12 h-12 text-green-600 mx-auto mb-3" />
                            <p className="text-xl font-bold text-green-800">Submitted to Itarang Team</p>
                            <p className="text-sm text-green-600 mt-2">Our sales manager will review all documents and get back to you with financing options.</p>
                            <button onClick={() => router.push('/dealer-portal/leads')} className="mt-6 px-8 py-3 bg-[#0047AB] text-white rounded-xl font-bold text-sm hover:bg-[#003580]">
                                Back to Leads
                            </button>
                        </div>
                    )}

                    {/* OTHER DOCUMENTATION */}
                    {otherDocRequests.length > 0 && (
                        <SectionCard title="Other Documentation (Requested by iTarang)">
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
                            {otherDocsStatus !== 'pending_review' && (
                                <button onClick={handleSubmitOtherDocs} className="px-6 py-3 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all">
                                    Submit Documents for Review
                                </button>
                            )}
                            {otherDocsStatus === 'pending_review' && (
                                <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-xs font-medium text-amber-700">
                                    Documents submitted for review. Uploads are disabled until review is complete.
                                </div>
                            )}
                        </SectionCard>
                    )}
                </main>

                {/* BOTTOM BUTTONS */}
                <div className="sticky bottom-0 left-0 right-0 bg-[#F8F9FB] pt-4 pb-8 z-50">
                    <div className="max-w-[1200px] mx-auto px-6">
                        <div className="flex justify-between items-center bg-white border border-gray-100 rounded-[20px] px-8 py-5 shadow-[0_-8px_30px_rgb(0,0,0,0.04)]">
                            <div className="bg-gray-100 px-4 py-1.5 rounded-full">
                                <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">{lastSaved || 'Not saved'}</span>
                            </div>
                            <div className="flex gap-4">
                                <button onClick={() => router.back()} className="px-8 py-2.5 border-2 border-[#EBEBEB] rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50">Back</button>
                                <button onClick={() => handleSaveDraft(false)} disabled={saving} className="px-8 py-2.5 border-2 border-[#0047AB] rounded-xl text-sm font-bold text-[#0047AB] hover:bg-blue-50 flex items-center gap-2">
                                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save Draft
                                </button>
                                {!submitted && (
                                    <button onClick={handleSubmitToSM} disabled={submitting || cobDocsUploaded < requiredCobDocs.length} className="px-10 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] flex items-center gap-2 disabled:opacity-50">
                                        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                                        Submit to Itarang Team
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// --- SUB COMPONENTS ---

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="bg-white rounded-[24px] border border-[#E9ECEF] shadow-[0_8px_30px_rgb(0,0,0,0.02)]">
            <div className="flex items-center gap-4 px-8 pt-8 pb-4">
                <div className="w-[3px] h-6 bg-[#0047AB] rounded-full" />
                <h3 className="text-lg font-black text-gray-900 tracking-tight">{title}</h3>
            </div>
            <div className="p-8 pt-4">{children}</div>
        </div>
    );
}

function FormInput({ label, value, onChange, placeholder, type = 'text' }: any) {
    return (
        <div className="space-y-2">
            <label className="text-sm font-bold text-gray-900 px-1">{label}</label>
            <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="w-full h-11 px-6 bg-white border-2 border-[#EBEBEB] rounded-xl outline-none focus:border-[#1D4ED8] text-sm" />
        </div>
    );
}

function DocumentCard({ label, required, uploaded, status, failedReason, onUpload }: any) {
    return (
        <label className={`flex flex-col items-center justify-center p-6 border-2 rounded-2xl cursor-pointer transition-all min-h-[120px] ${uploaded ? status === 'failed' ? 'border-red-200 bg-red-50' : status === 'success' ? 'border-green-200 bg-green-50' : 'border-blue-200 bg-blue-50' : 'border-dashed border-gray-200 hover:border-[#0047AB] hover:bg-gray-50'}`}>
            <input type="file" className="hidden" accept="image/*,application/pdf" onChange={e => e.target.files?.[0] && onUpload(e.target.files[0])} />
            {uploaded ? (
                status === 'success' ? <CheckCircle2 className="w-6 h-6 text-green-500 mb-2" /> :
                    status === 'failed' ? <XCircle className="w-6 h-6 text-red-500 mb-2" /> :
                        <Clock className="w-6 h-6 text-blue-500 mb-2" />
            ) : <Upload className="w-6 h-6 text-gray-300 mb-2" />}
            <span className="text-xs font-bold text-gray-700 text-center">{label}</span>
            {required && !uploaded && <span className="text-[10px] text-red-400 mt-1">Required</span>}
            {uploaded && <span className="text-[10px] text-green-600 mt-1">Uploaded</span>}
            {failedReason && <span className="text-[10px] text-red-500 mt-1 text-center">{failedReason}</span>}
        </label>
    );
}

function StatusBadge({ status }: { status: string }) {
    const config: Record<string, { bg: string; text: string; label: string }> = {
        pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', label: 'Pending' },
        initiating: { bg: 'bg-orange-50', text: 'text-orange-700', label: 'Initiating' },
        awaiting_action: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Awaiting Action' },
        in_progress: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'In Progress' },
        success: { bg: 'bg-green-50', text: 'text-green-700', label: 'Success' },
        failed: { bg: 'bg-red-50', text: 'text-red-700', label: 'Failed' },
    };
    const c = config[status] || config.pending;
    return <span className={`px-3 py-1 rounded-full text-xs font-bold ${c.bg} ${c.text}`}>{c.label}</span>;
}
