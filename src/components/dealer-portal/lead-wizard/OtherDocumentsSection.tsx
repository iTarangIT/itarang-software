'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertCircle, CheckCircle2, Clock, Eye, Loader2, Plus, Upload, X,
} from 'lucide-react';
import { SectionCard } from './shared';

export type RequestedDoc = {
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

type Props = {
    leadId: string;
    docFor: 'primary' | 'co_borrower';
    onChanged?: (docs: RequestedDoc[]) => void;
    // Human-readable owner label rendered as a colored pill at the top of
    // the section (e.g. "Primary Borrower (Customer)" or "Co-Borrower").
    // Pass this when the same page renders multiple OtherDocumentsSection
    // instances side-by-side so the dealer can tell whose docs are whose.
    scopeLabel?: string;
};

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'];
const MAX_BYTES = 5 * 1024 * 1024;

function fmtUploadedAt(value: string | null): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
}

function StatusBadge({ status }: { status: string }) {
    if (status === 'verified') return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-[11px] font-bold">
            <CheckCircle2 className="w-3 h-3" /> Verified
        </span>
    );
    if (status === 'rejected') return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-red-100 text-red-700 rounded-full text-[11px] font-bold">
            <AlertCircle className="w-3 h-3" /> Rejected
        </span>
    );
    if (status === 'uploaded') return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[11px] font-bold">
            <Clock className="w-3 h-3" /> Pending Review
        </span>
    );
    return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-gray-100 text-gray-600 rounded-full text-[11px] font-bold">
            Not Uploaded
        </span>
    );
}

function DocCard({
    doc, uploading, onUpload,
}: {
    doc: RequestedDoc;
    uploading: boolean;
    onUpload: (file: File) => void;
}) {
    const status = doc.upload_status;
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
                <StatusBadge status={status} />
            </div>

            {doc.rejection_reason && (
                <div className={`mb-2 text-xs ${status === 'rejected' ? 'text-red-700 bg-red-50 border border-red-200' : 'text-gray-600 bg-gray-50 border border-gray-100'} rounded-lg px-3 py-2`}>
                    <span className="font-bold">{status === 'rejected' ? 'Rejection reason: ' : 'Admin reason: '}</span>
                    <span className="italic">{doc.rejection_reason}</span>
                </div>
            )}

            {doc.uploaded_at && (
                <p className="text-[11px] text-gray-500 mb-2">
                    Uploaded: {fmtUploadedAt(doc.uploaded_at)}
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
                        {uploading ? 'Uploading…' : buttonLabel}
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

export default function OtherDocumentsSection({ leadId, docFor, onChanged, scopeLabel }: Props) {
    const [docs, setDocs] = useState<RequestedDoc[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploadingMap, setUploadingMap] = useState<Record<string, boolean>>({});
    const [error, setError] = useState<string | null>(null);

    // Add-document form state
    const [adding, setAdding] = useState(false);
    const [newLabel, setNewLabel] = useState('');
    const [newFile, setNewFile] = useState<File | null>(null);
    const [creating, setCreating] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const notify = useCallback((next: RequestedDoc[]) => {
        if (onChanged) onChanged(next);
    }, [onChanged]);

    const fetchDocs = useCallback(async () => {
        try {
            const res = await fetch(`/api/kyc/${leadId}/requested-docs?doc_for=${docFor}`, { cache: 'no-store' });
            const json = await res.json();
            if (json?.success && Array.isArray(json.data)) {
                const sorted = [...json.data].sort((a: RequestedDoc, b: RequestedDoc) => {
                    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
                });
                setDocs(sorted);
                notify(sorted);
            }
        } catch {
            setError('Failed to load additional documents');
        } finally {
            setLoading(false);
        }
    }, [leadId, docFor, notify]);

    useEffect(() => { fetchDocs(); }, [fetchDocs]);

    const validateFile = (file: File): string | null => {
        if (!ACCEPTED_TYPES.includes(file.type)) return 'Only PNG, JPEG, JPG, and PDF files are allowed';
        if (file.size > MAX_BYTES) return 'File size must be 5MB or smaller';
        return null;
    };

    const handleUpload = async (requestId: string, file: File) => {
        const validationErr = validateFile(file);
        if (validationErr) { setError(validationErr); return; }

        setError(null);
        setUploadingMap(prev => ({ ...prev, [requestId]: true }));
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('requestId', requestId);
            const res = await fetch(`/api/kyc/${leadId}/requested-docs`, { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Upload failed');
            await fetchDocs();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed');
        } finally {
            setUploadingMap(prev => {
                const next = { ...prev };
                delete next[requestId];
                return next;
            });
        }
    };

    const handleAdd = async () => {
        const label = newLabel.trim();
        if (!label) { setError('Please enter a document name'); return; }
        if (!newFile) { setError('Please choose a file to upload'); return; }
        const validationErr = validateFile(newFile);
        if (validationErr) { setError(validationErr); return; }

        setCreating(true);
        setError(null);
        try {
            const createRes = await fetch(`/api/kyc/${leadId}/requested-docs/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ doc_label: label, doc_for: docFor }),
            });
            const createJson = await createRes.json();
            if (!createRes.ok || !createJson?.success || !createJson.data?.id) {
                throw new Error(createJson?.error?.message || 'Could not create document request');
            }
            const newId = createJson.data.id as string;

            const formData = new FormData();
            formData.append('file', newFile);
            formData.append('requestId', newId);
            const uploadRes = await fetch(`/api/kyc/${leadId}/requested-docs`, { method: 'POST', body: formData });
            const uploadJson = await uploadRes.json();
            if (!uploadRes.ok || !uploadJson?.success) {
                throw new Error(uploadJson?.error?.message || 'Upload failed');
            }

            setNewLabel('');
            setNewFile(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
            setAdding(false);
            await fetchDocs();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not add document');
        } finally {
            setCreating(false);
        }
    };

    const total = docs.length;
    const uploaded = docs.filter(d => !!d.file_url && d.upload_status !== 'rejected').length;
    const rejected = docs.filter(d => d.upload_status === 'rejected').length;

    if (loading) {
        return (
            <SectionCard title="Additional Documents">
                <div className="text-xs text-gray-500">Loading…</div>
            </SectionCard>
        );
    }

    return (
        <SectionCard
            title="Additional Documents"
            action={
                total > 0 ? (
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-gray-500">Uploaded:</span>
                        <span className={`text-sm font-black ${uploaded === total ? 'text-emerald-600' : 'text-[#0047AB]'}`}>
                            {uploaded}/{total}
                        </span>
                        {rejected > 0 && (
                            <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[11px] font-bold">
                                <AlertCircle className="w-3 h-3" /> {rejected} rejected
                            </span>
                        )}
                    </div>
                ) : null
            }
        >
            {scopeLabel && (
                <div className="mb-3 flex items-center gap-2">
                    <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">For:</span>
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ring-1 ${
                        docFor === 'co_borrower'
                            ? 'bg-purple-50 text-purple-700 ring-purple-200'
                            : 'bg-blue-50 text-blue-700 ring-blue-200'
                    }`}>
                        {scopeLabel}
                    </span>
                </div>
            )}

            <p className="text-xs text-gray-500 mb-4">
                Attach any extra documents not in the standard checklist (e.g. salary slip, NOC, alternative ID). Admin-requested documents also appear here.
            </p>

            {error && (
                <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button onClick={() => setError(null)} aria-label="Dismiss" className="text-red-700/60 hover:text-red-900">
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}

            {docs.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    {docs.map(doc => (
                        <DocCard
                            key={doc.id}
                            doc={doc}
                            uploading={!!uploadingMap[doc.id]}
                            onUpload={file => handleUpload(doc.id, file)}
                        />
                    ))}
                </div>
            )}

            {!adding ? (
                <button
                    type="button"
                    onClick={() => { setAdding(true); setError(null); }}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border-2 border-dashed border-[#0047AB] text-[#0047AB] text-xs font-bold hover:bg-blue-50 transition-all"
                >
                    <Plus className="w-3.5 h-3.5" /> Add Additional Document
                </button>
            ) : (
                <div className="rounded-2xl border-2 border-[#0047AB] bg-blue-50/40 p-4">
                    <div className="flex items-center justify-between mb-3">
                        <p className="text-xs font-bold text-gray-900">New Document</p>
                        <button
                            type="button"
                            onClick={() => { setAdding(false); setNewLabel(''); setNewFile(null); setError(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                            className="text-gray-500 hover:text-gray-900"
                            aria-label="Cancel"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="space-y-3">
                        <div>
                            <label className="block text-[11px] font-bold text-gray-700 mb-1">Document Name</label>
                            <input
                                type="text"
                                value={newLabel}
                                onChange={e => setNewLabel(e.target.value)}
                                placeholder="e.g. Salary Slip Mar 2026"
                                maxLength={120}
                                className="w-full h-10 px-3 bg-white border-2 border-[#EBEBEB] rounded-lg outline-none text-sm focus:border-[#1D4ED8] transition-all"
                            />
                        </div>
                        <div>
                            <label className="block text-[11px] font-bold text-gray-700 mb-1">File (PDF, PNG, JPG · max 5MB)</label>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/png,image/jpeg,image/jpg,application/pdf"
                                onChange={e => setNewFile(e.target.files?.[0] || null)}
                                className="block w-full text-xs text-gray-700 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-[#0047AB] file:text-white file:text-[11px] file:font-bold hover:file:bg-[#003580]"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleAdd}
                                disabled={creating || !newLabel.trim() || !newFile}
                                className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#0047AB] text-white rounded-lg text-xs font-bold hover:bg-[#003580] disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                                {creating ? 'Uploading…' : 'Save & Upload'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </SectionCard>
    );
}
