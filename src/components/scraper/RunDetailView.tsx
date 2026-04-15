"use client";

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle, XCircle, Loader2, Users, SkipForward, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrapedLeadsTable } from './ScrapedLeadsTable';
import { RunStatusBadge } from './ExplorationStatusBadge';
import { useState } from 'react';

function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
}

interface RunDetail {
    run: {
        id: string;
        status: string;
        started_at: string;
        completed_at: string | null;
        total_found: number;
        new_leads_saved: number;
        duplicates_skipped: number;
        error_message: string | null;
        triggered_by_name: string | null;
        search_queries: string[] | null;
    };
    leads: unknown[];
    dedup_logs: Array<{
        id: string;
        raw_dealer_name: string | null;
        raw_phone: string | null;
        raw_location: string | null;
        raw_source_url: string | null;
        skip_reason: string;
        created_at: string;
    }>;
}

function StatCard({
    icon: Icon,
    label,
    value,
    color,
}: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: number;
    color: string;
}) {
    return (
        <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-3 ${color}`}>
                <Icon className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{label}</p>
        </div>
    );
}

export function RunDetailView() {
    const params = useParams();
    const router = useRouter();
    const runId = params.id as string;
    const [activeTab, setActiveTab] = useState<'leads' | 'dupes'>('leads');

    const { data, isLoading, error } = useQuery<RunDetail>({
        queryKey: ['scraper-run-detail', runId],
        queryFn: async () => {
            const res = await fetch(`/api/scraper/runs/${runId}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return json.data;
        },
        refetchInterval: (query) => {
            const d = query.state.data as RunDetail | undefined;
            return d?.run.status === 'running' ? 4000 : false;
        },
    });

    if (isLoading) {
        return (
            <div className="space-y-4">
                <div className="h-8 w-48 bg-gray-100 animate-pulse rounded-lg" />
                <div className="grid grid-cols-3 gap-4">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-28 bg-gray-100 animate-pulse rounded-xl" />
                    ))}
                </div>
            </div>
        );
    }

    if (error || !data) {
        return (
            <p className="text-sm text-red-500 bg-red-50 p-4 rounded-xl">
                Failed to load run details.
            </p>
        );
    }

    const { run, dedup_logs } = data;

    return (
        <div className="space-y-6">
            {/* Back + Header */}
            <div className="flex items-start gap-4">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.back()}
                    className="mt-0.5"
                >
                    <ArrowLeft className="w-4 h-4 mr-1" />
                    Back
                </Button>
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <h1 className="text-lg font-bold text-gray-900 font-mono">{run.id}</h1>
                        <RunStatusBadge status={run.status} />
                        {run.status === 'running' && (
                            <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                        )}
                    </div>
                    <p className="text-sm text-gray-500">
                        Triggered by {run.triggered_by_name ?? 'Unknown'} ·{' '}
                        {fmtDate(run.started_at)}
                        {run.completed_at && (
                            <>
                                {' '}
                                → {new Date(run.completed_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                            </>
                        )}
                    </p>
                </div>
            </div>

            {/* Error banner */}
            {run.error_message && (
                <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-100 rounded-xl text-sm text-red-700">
                    <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{run.error_message}</span>
                </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                    icon={Target}
                    label="Total Found"
                    value={run.total_found ?? 0}
                    color="bg-gray-100 text-gray-600"
                />
                <StatCard
                    icon={Users}
                    label="New Leads Saved"
                    value={run.new_leads_saved ?? 0}
                    color="bg-green-100 text-green-600"
                />
                <StatCard
                    icon={SkipForward}
                    label="Duplicates Skipped"
                    value={run.duplicates_skipped ?? 0}
                    color="bg-orange-100 text-orange-600"
                />
            </div>

            {/* Search queries used */}
            {run.search_queries && run.search_queries.length > 0 && (
                <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                        Queries Used
                    </p>
                    <ul className="space-y-1">
                        {run.search_queries.map((q, i) => (
                            <li key={i} className="text-sm text-gray-600 flex items-start gap-2">
                                <span className="text-teal-500 mt-0.5">›</span>
                                {q}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Tabs */}
            <div>
                <div className="flex gap-1 border-b border-gray-100 mb-4">
                    {(['leads', 'dupes'] as const).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                                activeTab === tab
                                    ? 'border-teal-600 text-teal-700'
                                    : 'border-transparent text-gray-500 hover:text-gray-700'
                            }`}
                        >
                            {tab === 'leads'
                                ? `New Leads (${run.new_leads_saved ?? 0})`
                                : `Duplicates Skipped (${run.duplicates_skipped ?? 0})`}
                        </button>
                    ))}
                </div>

                {activeTab === 'leads' && (
                    <ScrapedLeadsTable runId={runId} showAssignButton />
                )}

                {activeTab === 'dupes' && (
                    <div className="overflow-hidden rounded-xl border border-gray-100">
                        {dedup_logs.length === 0 ? (
                            <div className="text-center py-8 text-gray-400 text-sm">
                                <CheckCircle className="w-6 h-6 mx-auto mb-2 text-green-400" />
                                No duplicates were skipped in this run.
                            </div>
                        ) : (
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                                        <th className="px-4 py-3 text-left font-medium">Dealer Name</th>
                                        <th className="px-4 py-3 text-left font-medium">Phone</th>
                                        <th className="px-4 py-3 text-left font-medium">Location</th>
                                        <th className="px-4 py-3 text-left font-medium">Skip Reason</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                    {dedup_logs.map((log) => (
                                        <tr key={log.id} className="hover:bg-gray-50/50">
                                            <td className="px-4 py-3 text-gray-700">
                                                {log.raw_dealer_name ?? '—'}
                                            </td>
                                            <td className="px-4 py-3 text-gray-500 text-xs">
                                                {log.raw_phone ?? '—'}
                                            </td>
                                            <td className="px-4 py-3 text-gray-500 text-xs">
                                                {log.raw_location ?? '—'}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-xs font-medium">
                                                    {log.skip_reason.replace(/_/g, ' ')}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
