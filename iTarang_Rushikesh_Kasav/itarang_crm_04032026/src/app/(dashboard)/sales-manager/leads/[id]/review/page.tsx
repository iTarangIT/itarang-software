'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
    ChevronLeft, Loader2, FileText, CheckCircle2, XCircle,
    AlertCircle, Eye, Shield, Send, Copy, Plus, X,
    ChevronRight, Clock, RefreshCw
} from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';

interface DocRecord {
    id: string;
    doc_type: string;
    file_url: string | null;
    verification_status: string;
    failed_reason: string | null;
    for: 'primary' | 'co_borrower';
}

interface Lead {
    id: string;
    reference_id: string;
    full_name: string;
    phone: string;
    payment_method: string;
    sm_review_status: string;
    has_co_borrower: boolean;
    dealer_id: string;
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-50">
                <h3 className="text-sm font-black text-gray-900 uppercase tracking-wider">{title}</h3>
            </div>
            <div className="p-6">{children}</div>
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        success: 'bg-green-50 text-green-700 border-green-200',
        pending: 'bg-gray-50 text-gray-500 border-gray-200',
        failed: 'bg-red-50 text-red-700 border-red-200',
        in_progress: 'bg-blue-50 text-blue-700 border-blue-200',
    };
    return (
        <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${map[status] || map.pending}`}>
            {status.replace(/_/g, ' ')}
        </span>
    );
}

export default function SMReviewPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;
    const { user } = useAuth();

    const [loading, setLoading] = useState(true);
    const [lead, setLead] = useState<Lead | null>(null);
    const [docs, setDocs] = useState<DocRecord[]>([]);
    const [verifications, setVerifications] = useState<any[]>([]);
    const [apiError, setApiError] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    // Decentro state
    const [panNumber, setPanNumber] = useState('');
    const [panVerifying, setPanVerifying] = useState(false);
    const [panResult, setPanResult] = useState<any>(null);
    const [aadhaarNumber, setAadhaarNumber] = useState('');
    const [aadhaarTxnId, setAadhaarTxnId] = useState('');
    const [aadhaarOtp, setAadhaarOtp] = useState('');
    const [aadhaarStep, setAadhaarStep] = useState<'input' | 'otp'>('input');
    const [aadhaarVerifying, setAadhaarVerifying] = useState(false);
    const [aadhaarResult, setAadhaarResult] = useState<any>(null);
    const [bankAccountNo, setBankAccountNo] = useState('');
    const [bankIfsc, setBankIfsc] = useState('');
    const [bankName, setBankName] = useState('');
    const [bankVerifying, setBankVerifying] = useState(false);
    const [bankResult, setBankResult] = useState<any>(null);

    // Doc request state
    const [docRequestLabel, setDocRequestLabel] = useState('');
    const [docRequestFor, setDocRequestFor] = useState<'primary' | 'co_borrower'>('primary');
    const [docRequestLinks, setDocRequestLinks] = useState<{ label: string; link: string }[]>([]);
    const [requestingDoc, setRequestingDoc] = useState(false);
    const [copiedLink, setCopiedLink] = useState<string | null>(null);

    const [markingVerified, setMarkingVerified] = useState(false);

    useEffect(() => {
        const load = async () => {
            try {
                const [leadRes, docsRes, verRes] = await Promise.all([
                    fetch(`/api/leads/${leadId}`),
                    fetch(`/api/kyc/${leadId}/documents`),
                    fetch(`/api/kyc/${leadId}/verifications`),
                ]);
                const [leadData, docsData, verData] = await Promise.all([
                    leadRes.json(), docsRes.json(), verRes.json(),
                ]);
                if (leadData.success) setLead(leadData.data);
                if (docsData.success) setDocs(docsData.data.map((d: any) => ({ ...d, for: 'primary' })));
                if (verData.success) setVerifications(verData.data);
            } catch { setApiError('Failed to load lead data'); }
            finally { setLoading(false); }
        };
        load();
    }, [leadId]);

    const handlePanVerify = async () => {
        if (!panNumber.trim()) return;
        setPanVerifying(true); setPanResult(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/decentro/pan`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pan_number: panNumber.trim() }),
            });
            const data = await res.json();
            setPanResult(data);
            const verRes = await fetch(`/api/kyc/${leadId}/verifications`);
            const verData = await verRes.json();
            if (verData.success) setVerifications(verData.data);
        } catch { setPanResult({ success: false, message: 'Request failed' }); }
        finally { setPanVerifying(false); }
    };

    const handleAadhaarSendOtp = async () => {
        if (!aadhaarNumber.trim()) return;
        setAadhaarVerifying(true); setAadhaarResult(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/decentro/aadhaar-otp`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aadhaar_number: aadhaarNumber.trim() }),
            });
            const data = await res.json();
            if (data.success && data.decentroTxnId) {
                setAadhaarTxnId(data.decentroTxnId); setAadhaarStep('otp');
                setAadhaarResult({ success: true, message: 'OTP sent to Aadhaar-linked mobile' });
            } else { setAadhaarResult({ success: false, message: data.message || 'Failed to send OTP' }); }
        } catch { setAadhaarResult({ success: false, message: 'Request failed' }); }
        finally { setAadhaarVerifying(false); }
    };

    const handleAadhaarVerifyOtp = async () => {
        if (!aadhaarOtp.trim() || !aadhaarTxnId) return;
        setAadhaarVerifying(true);
        try {
            const res = await fetch(`/api/kyc/${leadId}/decentro/aadhaar-verify`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decentro_txn_id: aadhaarTxnId, otp: aadhaarOtp.trim() }),
            });
            const data = await res.json();
            setAadhaarResult(data);
            if (data.success) {
                setAadhaarStep('input');
                const verRes = await fetch(`/api/kyc/${leadId}/verifications`);
                const verData = await verRes.json();
                if (verData.success) setVerifications(verData.data);
            }
        } catch { setAadhaarResult({ success: false, message: 'Request failed' }); }
        finally { setAadhaarVerifying(false); }
    };

    const handleBankVerify = async () => {
        if (!bankAccountNo.trim() || !bankIfsc.trim()) return;
        setBankVerifying(true); setBankResult(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/decentro/bank`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_number: bankAccountNo.trim(), ifsc: bankIfsc.trim(), name: bankName.trim() || undefined, perform_name_match: !!bankName.trim() }),
            });
            const data = await res.json();
            setBankResult(data);
            const verRes = await fetch(`/api/kyc/${leadId}/verifications`);
            const verData = await verRes.json();
            if (verData.success) setVerifications(verData.data);
        } catch { setBankResult({ success: false, message: 'Request failed' }); }
        finally { setBankVerifying(false); }
    };

    const handleRequestDoc = async () => {
        if (!docRequestLabel.trim()) return;
        setRequestingDoc(true);
        try {
            const res = await fetch(`/api/sm/leads/${leadId}/request-doc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ doc_label: docRequestLabel.trim(), doc_for: docRequestFor }),
            });
            const data = await res.json();
            if (data.success) {
                setDocRequestLinks(prev => [...prev, { label: docRequestLabel.trim(), link: data.data.upload_link }]);
                setDocRequestLabel('');
                setSuccessMsg('Upload link created. Copy and share it with the customer.');
            } else { setApiError(data.error?.message || 'Failed to create request'); }
        } catch { setApiError('Request failed'); }
        finally { setRequestingDoc(false); }
    };

    const handleCopyLink = (link: string) => {
        navigator.clipboard.writeText(link);
        setCopiedLink(link);
        setTimeout(() => setCopiedLink(null), 2000);
    };

    const handleMarkVerified = async () => {
        setMarkingVerified(true);
        try {
            const res = await fetch(`/api/sm/leads/${leadId}/mark-verified`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setSuccessMsg('Documents marked as verified. Proceed to enter loan offers.');
                setLead(prev => prev ? { ...prev, sm_review_status: 'docs_verified' } : prev);
            } else { setApiError(data.error?.message || 'Failed to mark verified'); }
        } catch { setApiError('Request failed'); }
        finally { setMarkingVerified(false); }
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]"><Loader2 className="w-10 h-10 animate-spin text-[#1D4ED8]" /></div>;
    if (!lead) return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Lead not found</p></div>;

    const statusColors: Record<string, string> = {
        pending_sm_review: 'bg-amber-50 text-amber-700 border-amber-200',
        under_review: 'bg-blue-50 text-blue-700 border-blue-200',
        docs_verified: 'bg-green-50 text-green-700 border-green-200',
        options_ready: 'bg-purple-50 text-purple-700 border-purple-200',
    };

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1100px] mx-auto px-6 py-8 pb-32">

                {/* HEADER */}
                <header className="mb-8 flex justify-between items-start">
                    <div className="flex gap-4">
                        <button onClick={() => router.back()} className="mt-1 p-2 hover:bg-white rounded-lg transition-colors">
                            <ChevronLeft className="w-6 h-6 text-gray-900" />
                        </button>
                        <div>
                            <h1 className="text-[28px] font-black text-gray-900">KYC Review</h1>
                            <p className="text-sm text-gray-500 mt-0.5">
                                {lead.reference_id} &mdash; {lead.full_name} &mdash; {lead.phone}
                            </p>
                        </div>
                    </div>
                    <div className={`px-4 py-2 rounded-full text-xs font-bold border ${statusColors[lead.sm_review_status] || 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                        {lead.sm_review_status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </div>
                </header>

                {apiError && (
                    <div className="mb-6 bg-red-50 border border-red-200 p-4 rounded-xl flex items-center justify-between">
                        <span className="text-sm text-red-700 font-medium flex items-center gap-2"><AlertCircle className="w-4 h-4" />{apiError}</span>
                        <button onClick={() => setApiError(null)}><X className="w-4 h-4 text-red-400" /></button>
                    </div>
                )}
                {successMsg && (
                    <div className="mb-6 bg-green-50 border border-green-200 p-4 rounded-xl flex items-center justify-between">
                        <span className="text-sm text-green-700 font-medium flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />{successMsg}</span>
                        <button onClick={() => setSuccessMsg(null)}><X className="w-4 h-4 text-green-400" /></button>
                    </div>
                )}

                <div className="space-y-6">

                    {/* DOCUMENTS */}
                    <SectionCard title="Uploaded Documents">
                        {docs.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-4">No documents uploaded yet</p>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {docs.map(doc => (
                                    <div key={doc.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100">
                                        <div className="flex items-center gap-3">
                                            <FileText className="w-5 h-5 text-gray-400" />
                                            <div>
                                                <p className="text-sm font-bold text-gray-900">{doc.doc_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</p>
                                                <StatusBadge status={doc.verification_status} />
                                            </div>
                                        </div>
                                        {doc.file_url && (
                                            <a href={doc.file_url} target="_blank" rel="noopener noreferrer"
                                                className="p-2 hover:bg-white rounded-lg border border-gray-200 transition-colors">
                                                <Eye className="w-4 h-4 text-[#0047AB]" />
                                            </a>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </SectionCard>

                    {/* DECENTRO VERIFICATION */}
                    <SectionCard title="Identity Verification (Decentro)">
                        <div className="space-y-6">
                            {/* PAN */}
                            <div>
                                <p className="text-xs font-black text-gray-500 uppercase tracking-wider mb-3">PAN Verification</p>
                                <div className="flex gap-3">
                                    <input value={panNumber} onChange={e => setPanNumber(e.target.value.toUpperCase())}
                                        placeholder="Enter PAN number" maxLength={10}
                                        className="flex-1 h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                                    <button onClick={handlePanVerify} disabled={panVerifying || !panNumber.trim()}
                                        className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2">
                                        {panVerifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />} Verify
                                    </button>
                                </div>
                                {panResult && (
                                    <p className={`mt-2 text-xs font-medium ${panResult.success ? 'text-green-600' : 'text-red-600'}`}>
                                        {panResult.success ? '✓' : '✗'} {panResult.message}
                                    </p>
                                )}
                            </div>

                            {/* AADHAAR OTP */}
                            <div>
                                <p className="text-xs font-black text-gray-500 uppercase tracking-wider mb-3">Aadhaar OTP Verification</p>
                                {aadhaarStep === 'input' ? (
                                    <div className="flex gap-3">
                                        <input value={aadhaarNumber} onChange={e => setAadhaarNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
                                            placeholder="Enter 12-digit Aadhaar number" maxLength={12}
                                            className="flex-1 h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                                        <button onClick={handleAadhaarSendOtp} disabled={aadhaarVerifying || aadhaarNumber.length < 12}
                                            className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2">
                                            {aadhaarVerifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send OTP
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex gap-3">
                                        <input value={aadhaarOtp} onChange={e => setAadhaarOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                            placeholder="Enter OTP" maxLength={6}
                                            className="flex-1 h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                                        <button onClick={handleAadhaarVerifyOtp} disabled={aadhaarVerifying}
                                            className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2">
                                            {aadhaarVerifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />} Verify OTP
                                        </button>
                                        <button onClick={() => setAadhaarStep('input')} className="px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50">
                                            Back
                                        </button>
                                    </div>
                                )}
                                {aadhaarResult && (
                                    <p className={`mt-2 text-xs font-medium ${aadhaarResult.success ? 'text-green-600' : 'text-red-600'}`}>
                                        {aadhaarResult.success ? '✓' : '✗'} {aadhaarResult.message}
                                    </p>
                                )}
                            </div>

                            {/* BANK */}
                            <div>
                                <p className="text-xs font-black text-gray-500 uppercase tracking-wider mb-3">Bank Account Verification</p>
                                <div className="grid grid-cols-3 gap-3 mb-3">
                                    <input value={bankAccountNo} onChange={e => setBankAccountNo(e.target.value.replace(/\D/g, ''))}
                                        placeholder="Account number" className="h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                                    <input value={bankIfsc} onChange={e => setBankIfsc(e.target.value.toUpperCase())}
                                        placeholder="IFSC code" maxLength={11} className="h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                                    <input value={bankName} onChange={e => setBankName(e.target.value)}
                                        placeholder="Account holder (optional)" className="h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                </div>
                                <button onClick={handleBankVerify} disabled={bankVerifying || !bankAccountNo.trim() || !bankIfsc.trim()}
                                    className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2">
                                    {bankVerifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />} Verify Bank Account
                                </button>
                                {bankResult && (
                                    <p className={`mt-2 text-xs font-medium ${bankResult.success ? 'text-green-600' : 'text-red-600'}`}>
                                        {bankResult.success ? '✓' : '✗'} {bankResult.message}
                                    </p>
                                )}
                            </div>

                            {/* Verification Results */}
                            {verifications.length > 0 && (
                                <div className="mt-4">
                                    <p className="text-xs font-black text-gray-500 uppercase tracking-wider mb-3">Verification Results</p>
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-gray-100">
                                                <th className="text-left py-2 px-3 text-xs font-bold text-gray-500">Check</th>
                                                <th className="text-left py-2 px-3 text-xs font-bold text-gray-500">Status</th>
                                                <th className="text-left py-2 px-3 text-xs font-bold text-gray-500">Updated</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {verifications.map((v: any) => (
                                                <tr key={v.type} className="border-b border-gray-50">
                                                    <td className="py-2 px-3 font-medium text-sm">{v.label}</td>
                                                    <td className="py-2 px-3"><StatusBadge status={v.status} /></td>
                                                    <td className="py-2 px-3 text-xs text-gray-400">{v.last_update || '-'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </SectionCard>

                    {/* REQUEST ADDITIONAL DOCUMENTS */}
                    <SectionCard title="Request Additional Documents">
                        <div className="space-y-4">
                            <div className="flex gap-3">
                                <input
                                    value={docRequestLabel}
                                    onChange={e => setDocRequestLabel(e.target.value)}
                                    placeholder="Document name (e.g. Rent Agreement, ITR 2 years)"
                                    className="flex-1 h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]"
                                />
                                <select
                                    value={docRequestFor}
                                    onChange={e => setDocRequestFor(e.target.value as 'primary' | 'co_borrower')}
                                    className="h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]"
                                >
                                    <option value="primary">Primary Borrower</option>
                                    <option value="co_borrower">Co-Borrower</option>
                                </select>
                                <button onClick={handleRequestDoc} disabled={requestingDoc || !docRequestLabel.trim()}
                                    className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2">
                                    {requestingDoc ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Generate Link
                                </button>
                            </div>
                            <p className="text-xs text-gray-400">Copy the generated link and send it to the customer via WhatsApp or SMS.</p>

                            {docRequestLinks.length > 0 && (
                                <div className="space-y-3 mt-4">
                                    {docRequestLinks.map((req, i) => (
                                        <div key={i} className="flex items-center justify-between p-4 bg-blue-50 border border-blue-200 rounded-xl">
                                            <div>
                                                <p className="text-sm font-bold text-blue-900">{req.label}</p>
                                                <p className="text-xs text-blue-500 font-mono mt-0.5 truncate max-w-md">{req.link}</p>
                                            </div>
                                            <button onClick={() => handleCopyLink(req.link)}
                                                className="flex items-center gap-1.5 px-3 py-2 bg-white border border-blue-200 rounded-lg text-xs font-bold text-[#0047AB] hover:bg-blue-50 transition-colors">
                                                {copiedLink === req.link ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                {copiedLink === req.link ? 'Copied!' : 'Copy Link'}
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </SectionCard>

                </div>
            </div>

            {/* BOTTOM BAR */}
            <div className="sticky bottom-0 left-0 right-0 bg-[#F8F9FB] pt-4 pb-8 z-50">
                <div className="max-w-[1100px] mx-auto px-6">
                    <div className="flex justify-between items-center bg-white border border-gray-100 rounded-[20px] px-8 py-5 shadow-[0_-8px_30px_rgb(0,0,0,0.04)]">
                        <div>
                            <p className="text-xs text-gray-500">After verifying all documents, mark them as verified to proceed to loan offers.</p>
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => router.push(`/sales-manager/leads/${leadId}/options`)}
                                className="px-6 py-2.5 border-2 border-[#0047AB] text-[#0047AB] rounded-xl text-sm font-bold hover:bg-blue-50 flex items-center gap-2">
                                Loan Offers <ChevronRight className="w-4 h-4" />
                            </button>
                            {lead.sm_review_status !== 'docs_verified' && lead.sm_review_status !== 'options_ready' && lead.sm_review_status !== 'option_booked' && (
                                <button onClick={handleMarkVerified} disabled={markingVerified}
                                    className="px-8 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] disabled:opacity-50 flex items-center gap-2">
                                    {markingVerified ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                    Mark Documents Verified
                                </button>
                            )}
                            {(lead.sm_review_status === 'docs_verified' || lead.sm_review_status === 'options_ready') && (
                                <div className="px-6 py-2.5 bg-green-50 border border-green-200 rounded-xl text-sm font-bold text-green-700 flex items-center gap-2">
                                    <CheckCircle2 className="w-4 h-4" /> Documents Verified
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
