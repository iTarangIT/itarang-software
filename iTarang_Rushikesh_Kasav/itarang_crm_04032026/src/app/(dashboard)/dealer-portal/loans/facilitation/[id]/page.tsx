'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft, FileText, CreditCard, ShieldCheck, RefreshCw, AlertCircle } from 'lucide-react';

type Detail = {
    id: string;
    lead_id: string;
    applicant_name: string;
    phone: string | null;
    documents_uploaded: boolean;
    company_validation_status: string;
    facilitation_fee_status: string;
    facilitation_fee_amount: string | null;
    application_status: string;
    created_at: string;
    updated_at: string;
};

export default function LoanFacilitationDetailPage() {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const id = params?.id;

    const [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(true);
    const [paying, setPaying] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchDetail = async () => {
        if (!id) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/dealer/loan-facilitation/${encodeURIComponent(id)}`, { credentials: 'include' });
            const data = await res.json();
            if (res.ok && data.success) setDetail(data.data);
            else setError('Could not load loan file');
        } catch {
            setError('Connection lost. Please try again');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchDetail();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    const payFee = async () => {
        if (!id) return;
        setPaying(true);
        setError(null);
        try {
            const res = await fetch(`/api/dealer/loan-facilitation/${encodeURIComponent(id)}/pay-fee`, {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json();
            if (res.ok && data.success) {
                await fetchDetail();
            } else {
                setError('Payment failed. Please try again.');
            }
        } catch {
            setError('Connection lost. Please try again.');
        } finally {
            setPaying(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <Link
                        href="/dealer-portal/loans/facilitation"
                        className="mt-1 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        Back
                    </Link>
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900">Process Loan File</h1>
                        <p className="text-gray-500 mt-1">Review documents, validation status, and pay facilitation fee.</p>
                    </div>
                </div>
                <button
                    onClick={fetchDetail}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {loading ? (
                <div className="p-8 bg-white rounded-2xl border border-gray-100 shadow-sm">
                    <div className="h-6 w-56 bg-gray-100 rounded animate-pulse" />
                    <div className="h-4 w-80 bg-gray-50 rounded mt-3 animate-pulse" />
                    <div className="h-4 w-64 bg-gray-50 rounded mt-2 animate-pulse" />
                </div>
            ) : error ? (
                <div className="p-6 bg-white rounded-2xl border border-gray-100 shadow-sm text-red-600 flex items-center gap-2">
                    <AlertCircle className="w-5 h-5" />
                    {error}
                </div>
            ) : !detail ? (
                <div className="p-6 bg-white rounded-2xl border border-gray-100 shadow-sm text-gray-500">No data.</div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2 space-y-6">
                        {/* Uploaded documents viewer (Pseudo) */}
                        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                            <div className="p-5 border-b border-gray-100 flex items-center gap-3">
                                <div className="p-2 rounded-xl bg-brand-50 text-brand-700">
                                    <FileText className="w-5 h-5" />
                                </div>
                                <div>
                                    <h2 className="font-bold text-gray-900">Uploaded Documents</h2>
                                    <p className="text-sm text-gray-500">(Pseudo screen) Connect this to your document storage when ready.</p>
                                </div>
                            </div>
                            <div className="p-5 text-sm text-gray-600 space-y-3">
                                <div className="p-4 rounded-xl bg-gray-50 border border-gray-100">
                                    <div className="font-semibold text-gray-900">Document Viewer Placeholder</div>
                                    <div className="text-gray-500 mt-1">
                                        This section should list uploaded KYC / bank / RC documents with preview thumbnails, statuses, and re-upload.
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <InfoRow title="Documents Uploaded" value={detail.documents_uploaded ? 'Yes' : 'No'} />
                                    <InfoRow title="Company Validation" value={detail.company_validation_status} />
                                    <InfoRow title="Application Status" value={detail.application_status} />
                                    <InfoRow title="Lead ID" value={detail.lead_id} />
                                </div>
                            </div>
                        </div>

                        {/* Validation notes (Pseudo) */}
                        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                            <div className="p-5 border-b border-gray-100 flex items-center gap-3">
                                <div className="p-2 rounded-xl bg-indigo-50 text-indigo-700">
                                    <ShieldCheck className="w-5 h-5" />
                                </div>
                                <div>
                                    <h2 className="font-bold text-gray-900">Validation Notes</h2>
                                    <p className="text-sm text-gray-500">(Pseudo screen) Show internal validation feedback here.</p>
                                </div>
                            </div>
                            <div className="p-5 text-sm text-gray-600">
                                <div className="p-4 rounded-xl bg-gray-50 border border-gray-100">
                                    No notes yet. When your internal validation dashboard updates this file, display notes & timestamps here.
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Fee card */}
                    <div className="space-y-6">
                        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                            <div className="p-5 border-b border-gray-100 flex items-center gap-3">
                                <div className="p-2 rounded-xl bg-green-50 text-green-700">
                                    <CreditCard className="w-5 h-5" />
                                </div>
                                <div>
                                    <h2 className="font-bold text-gray-900">Facilitation Fee</h2>
                                    <p className="text-sm text-gray-500">Pay to move file to Loan Management.</p>
                                </div>
                            </div>
                            <div className="p-5">
                                <div className="text-xs text-gray-400">Amount</div>
                                <div className="text-3xl font-extrabold text-gray-900">{detail.facilitation_fee_amount ? `₹ ${detail.facilitation_fee_amount}` : '—'}</div>

                                <div className="mt-3">
                                    <Badge label={`Status: ${detail.facilitation_fee_status}`} tone={detail.facilitation_fee_status === 'paid' ? 'green' : 'red'} />
                                </div>

                                <button
                                    onClick={payFee}
                                    disabled={paying || (detail.facilitation_fee_status || '').toLowerCase() === 'paid'}
                                    className={`mt-5 w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold ${(detail.facilitation_fee_status || '').toLowerCase() === 'paid'
                                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                            : 'bg-brand-600 hover:bg-brand-700 text-white'
                                        }`}
                                >
                                    <CreditCard className={`w-4 h-4 ${paying ? 'animate-pulse' : ''}`} />
                                    {paying ? 'Processing…' : (detail.facilitation_fee_status || '').toLowerCase() === 'paid' ? 'Fee Paid' : 'Pay Facilitation Fee'}
                                </button>

                                <button
                                    onClick={() => router.push(`/dealer-portal/loans`)}
                                    className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold"
                                >
                                    Go to Loan Management
                                </button>
                            </div>
                        </div>

                        <div className="p-4 rounded-2xl bg-yellow-50 border border-yellow-200 text-yellow-900 text-sm">
                            After fee payment, this sample implementation sets <span className="font-semibold">facilitation_fee_status = paid</span> and <span className="font-semibold">application_status = processing</span>.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function InfoRow({ title, value }: { title: string; value: string }) {
    return (
        <div className="p-4 rounded-xl bg-white border border-gray-100">
            <div className="text-xs text-gray-400">{title}</div>
            <div className="mt-1 font-semibold text-gray-900 truncate">{value}</div>
        </div>
    );
}

function Badge({ label, tone }: { label: string; tone: 'green' | 'red' }) {
    const cls = tone === 'green' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
    return <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold capitalize ${cls}`}>{label}</span>;
}