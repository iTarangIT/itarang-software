'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { FileCheck, Filter, ArrowRight, RefreshCw } from 'lucide-react';

type Row = {
    id: string;
    lead_id: string;
    applicant_name: string;
    phone: string | null;
    documents_uploaded: boolean;
    company_validation_status: string;
    facilitation_fee_status: string;
    facilitation_fee_amount: string | null;
    updated_at: string;
};

const FILTERS: Array<{ id: string; label: string }> = [
    { id: '', label: 'All (Docs Uploaded)' },
    { id: 'under_validation', label: 'Under Validation' },
    { id: 'validation_passed', label: 'Validation Passed' },
    { id: 'fee_pending', label: 'Fee Pending' },
];

export default function LoanFacilitationQueuePage() {
    const [rows, setRows] = useState<Row[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('fee_pending');

    const fetchQueue = async () => {
        setLoading(true);
        try {
            const url = `/api/dealer/loan-facilitation/queue${filter ? `?filter=${encodeURIComponent(filter)}` : ''}`;
            const res = await fetch(url, { credentials: 'include' });
            const data = await res.json();
            if (res.ok && data.success) setRows(data.data);
            else setRows([]);
        } catch {
            setRows([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchQueue();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filter]);

    const counts = useMemo(() => {
        const all = rows.length;
        const feePending = rows.filter(r => (r.facilitation_fee_status || '').toLowerCase() === 'pending').length;
        const underValidation = rows.filter(r => (r.company_validation_status || '').toLowerCase() === 'pending').length;
        const validationPassed = rows.filter(r => (r.company_validation_status || '').toLowerCase() === 'passed').length;
        return { all, feePending, underValidation, validationPassed };
    }, [rows]);

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Loan Facilitation Queue</h1>
                    <p className="text-gray-500 mt-1">Files where documents are uploaded and facilitation fee is pending / validation is in progress.</p>
                </div>
                <button
                    onClick={fetchQueue}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {/* Filter pills */}
            <div className="flex items-center gap-2 flex-wrap">
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-gray-400 tracking-widest uppercase mr-2">
                    <Filter className="w-4 h-4" />
                    Filters
                </div>
                {FILTERS.map(f => (
                    <button
                        key={f.id}
                        onClick={() => setFilter(f.id)}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${filter === f.id ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {/* Counters */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat title="In Queue" value={counts.all} />
                <Stat title="Fee Pending" value={counts.feePending} />
                <Stat title="Under Validation" value={counts.underValidation} />
                <Stat title="Validation Passed" value={counts.validationPassed} />
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-gray-100 flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600">
                        <FileCheck className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="font-bold text-gray-900">Applications</h2>
                        <p className="text-sm text-gray-500">Click “Process” to view documents, validation notes, and pay facilitation fee.</p>
                    </div>
                </div>

                {loading ? (
                    <div className="p-8 space-y-3">
                        {[1, 2, 3, 4].map(i => (
                            <div key={i} className="h-14 bg-gray-50 rounded-xl animate-pulse" />
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    <div className="p-8 text-sm text-gray-500">No applications found for this filter.</div>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {rows.map(r => (
                            <div key={r.id} className="p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="font-semibold text-gray-900 truncate">{r.applicant_name} <span className="text-gray-400 font-medium">· {r.id}</span></div>
                                    <div className="text-sm text-gray-500 truncate">
                                        {r.phone ? `Mobile: ${r.phone} · ` : ''}Lead: {r.lead_id}
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <Badge label={`Docs: ${r.documents_uploaded ? 'Uploaded' : 'Pending'}`} tone={r.documents_uploaded ? 'green' : 'gray'} />
                                        <Badge label={`Validation: ${r.company_validation_status}`} tone={r.company_validation_status === 'passed' ? 'green' : r.company_validation_status === 'failed' ? 'red' : 'yellow'} />
                                        <Badge label={`Fee: ${r.facilitation_fee_status}`} tone={r.facilitation_fee_status === 'paid' ? 'green' : 'red'} />
                                    </div>
                                </div>

                                <div className="flex items-center gap-3">
                                    <div className="text-right">
                                        <div className="text-xs text-gray-400">Facilitation Fee</div>
                                        <div className="text-lg font-bold text-gray-900">{r.facilitation_fee_amount ? `₹ ${r.facilitation_fee_amount}` : '—'}</div>
                                    </div>
                                    <Link
                                        href={`/dealer-portal/loans/facilitation/${encodeURIComponent(r.id)}`}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold"
                                    >
                                        Process <ArrowRight className="w-4 h-4" />
                                    </Link>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function Stat({ title, value }: { title: string; value: number }) {
    return (
        <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
            <div className="text-xs font-semibold text-gray-400 tracking-widest uppercase">{title}</div>
            <div className="mt-1 text-2xl font-extrabold text-gray-900">{value}</div>
        </div>
    );
}

function Badge({ label, tone }: { label: string; tone: 'green' | 'red' | 'yellow' | 'gray' }) {
    const cls =
        tone === 'green' ? 'bg-green-50 text-green-700' :
            tone === 'red' ? 'bg-red-50 text-red-700' :
                tone === 'yellow' ? 'bg-yellow-50 text-yellow-700' :
                    'bg-gray-100 text-gray-700';
    return <span className={`px-2.5 py-1 rounded-full text-xs font-semibold capitalize ${cls}`}>{label}</span>;
}