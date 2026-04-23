'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    PlusCircle, Search, Filter, Loader2, Trash2, X, AlertTriangle,
    FileText, ChevronRight, CheckCircle2, Clock,
} from 'lucide-react';

type Draft = {
    id: string;
    reference_id: string | null;
    owner_name: string | null;
    owner_contact: string | null;
    workflow_step: number;
    consent_status: string;
    progress: { docsUploaded: number; docsRequired: number; consentComplete: boolean } | null;
    progress_percent: number;
    last_saved_at: string | null;
    created_at: string | null;
};

function timeAgo(iso: string | null) {
    if (!iso) return '—';
    const then = new Date(iso).getTime();
    const diff = Date.now() - then;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
}

function consentBadge(status: string) {
    const s = (status || '').toLowerCase();
    if (['verified', 'admin_verified', 'manual_verified', 'esign_completed'].includes(s)) {
        return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                <CheckCircle2 className="w-3 h-3" /> Signed
            </span>
        );
    }
    if (['link_sent', 'link_opened', 'esign_in_progress', 'admin_review_pending', 'consent_uploaded'].includes(s)) {
        return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                <Clock className="w-3 h-3" /> In progress
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
            Pending
        </span>
    );
}

export default function DraftsPage() {
    const router = useRouter();
    const queryClient = useQueryClient();

    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [bucket, setBucket] = useState<'All' | 'low' | 'mid' | 'high'>('All');
    const [deleteTarget, setDeleteTarget] = useState<Draft | null>(null);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), 500);
        return () => clearTimeout(timer);
    }, [search]);

    const { data: drafts = [], isLoading } = useQuery<Draft[]>({
        queryKey: ['dealer-drafts', debouncedSearch, bucket],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (debouncedSearch) params.append('search', debouncedSearch);
            if (bucket !== 'All') params.append('bucket', bucket);
            const res = await fetch(`/api/dealer/leads/drafts?${params.toString()}`);
            const json = await res.json();
            if (!res.ok || !json?.success) {
                throw new Error(json?.error?.message || 'Failed to load drafts');
            }
            return json.data;
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (leadId: string) => {
            const res = await fetch(`/api/dealer/leads/drafts/${leadId}`, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok || !json?.success) {
                throw new Error(json?.error?.message || 'Failed to delete draft');
            }
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['dealer-drafts'] });
            toast.success('Draft cleared. The lead is kept — you can restart KYC anytime.');
            setDeleteTarget(null);
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">My Drafts</h1>
                    <p className="text-gray-500 text-sm">KYC forms you&apos;ve saved to finish later. Auto-saved every 2 minutes while you work.</p>
                </div>
                <Link
                    href="/dealer-portal/leads/new"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white font-medium rounded-lg hover:bg-brand-700 transition-colors shadow-sm"
                >
                    <PlusCircle className="w-5 h-5" />
                    New Lead
                </Link>
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4 p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by name or phone..."
                        className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
                    />
                </div>
                <select
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value as any)}
                    className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                    <option value="All">All progress</option>
                    <option value="low">&lt; 25% complete</option>
                    <option value="mid">25%–75% complete</option>
                    <option value="high">&gt; 75% complete</option>
                </select>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden min-h-[300px]">
                {isLoading ? (
                    <div className="flex items-center justify-center h-48">
                        <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
                    </div>
                ) : drafts.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 text-gray-500 px-6 text-center">
                        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                            <FileText className="w-6 h-6 text-gray-400" />
                        </div>
                        <p className="font-medium text-gray-700">No drafts yet</p>
                        <p className="text-sm mt-1">Open any KYC form and click <span className="font-semibold">Save Draft</span> to park it here. Auto-save will keep this list fresh as you work.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50 border-b border-gray-200 text-xs uppercase text-gray-500 font-semibold tracking-wider">
                                    <th className="px-6 py-4">Customer</th>
                                    <th className="px-6 py-4 w-52">Progress</th>
                                    <th className="px-6 py-4">Step</th>
                                    <th className="px-6 py-4">Consent</th>
                                    <th className="px-6 py-4">Last saved</th>
                                    <th className="px-6 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 text-sm">
                                {drafts.map((d) => (
                                    <tr key={d.id} className="hover:bg-gray-50 transition-colors group">
                                        <td className="px-6 py-4">
                                            <div className="font-medium text-gray-900">{d.owner_name || 'Unnamed customer'}</div>
                                            <div className="text-gray-500 text-xs">{d.owner_contact || d.id}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full rounded-full transition-all ${d.progress_percent >= 75 ? 'bg-emerald-500' : d.progress_percent >= 25 ? 'bg-amber-500' : 'bg-gray-400'}`}
                                                        style={{ width: `${d.progress_percent}%` }}
                                                    />
                                                </div>
                                                <span className="text-xs font-semibold text-gray-700 w-8 text-right">{d.progress_percent}%</span>
                                            </div>
                                            {d.progress && (
                                                <div className="text-xs text-gray-400 mt-1">
                                                    {d.progress.docsUploaded}/{d.progress.docsRequired} docs · consent {d.progress.consentComplete ? 'verified' : 'pending'}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-gray-600 text-xs font-medium">Step {d.workflow_step}</td>
                                        <td className="px-6 py-4">{consentBadge(d.consent_status)}</td>
                                        <td className="px-6 py-4 text-gray-500 text-xs" title={d.last_saved_at ? new Date(d.last_saved_at).toLocaleString() : ''}>
                                            {timeAgo(d.last_saved_at)}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() => router.push(`/dealer-portal/leads/${d.id}/kyc`)}
                                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-brand-50 text-brand-700 hover:bg-brand-100 rounded-lg text-xs font-semibold transition-all"
                                                >
                                                    Resume <ChevronRight className="w-3 h-3" />
                                                </button>
                                                <button
                                                    onClick={() => setDeleteTarget(d)}
                                                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                                                    title="Delete draft"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Delete confirmation */}
            {deleteTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
                        <div className="bg-gradient-to-r from-amber-500 to-amber-600 px-6 py-5">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                                        <AlertTriangle className="w-5 h-5 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-white">Clear Draft</h3>
                                        <p className="text-amber-50 text-xs mt-0.5">The lead and uploaded documents are kept</p>
                                    </div>
                                </div>
                                <button onClick={() => setDeleteTarget(null)} className="text-white/70 hover:text-white">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                        <div className="px-6 py-5 space-y-4">
                            <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 space-y-1.5">
                                <div className="flex justify-between text-sm">
                                    <span className="text-gray-500">Customer</span>
                                    <span className="font-semibold text-gray-900">{deleteTarget.owner_name || 'Unnamed'}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-gray-500">Lead ID</span>
                                    <span className="font-mono text-gray-900 text-xs">{deleteTarget.id}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-gray-500">Progress</span>
                                    <span className="font-semibold text-gray-900">{deleteTarget.progress_percent}%</span>
                                </div>
                            </div>
                            <p className="text-xs text-gray-500">
                                This removes only the draft snapshot. Uploaded documents and the lead record stay intact — you can restart KYC from the lead any time.
                            </p>
                        </div>
                        <div className="px-6 pb-5 flex gap-3">
                            <button
                                onClick={() => setDeleteTarget(null)}
                                disabled={deleteMutation.isPending}
                                className="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl font-semibold text-sm text-gray-600 hover:bg-gray-50 transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => deleteMutation.mutate(deleteTarget.id)}
                                disabled={deleteMutation.isPending}
                                className="flex-1 px-4 py-3 bg-amber-600 text-white rounded-xl font-semibold text-sm hover:bg-amber-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                {deleteMutation.isPending ? 'Clearing...' : 'Clear Draft'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
