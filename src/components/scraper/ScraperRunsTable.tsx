"use client";

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Clock, CheckCircle, XCircle, Loader2, ChevronRight } from 'lucide-react';
import { RunStatusBadge } from './ExplorationStatusBadge';

function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
}

interface RunRow {
    id: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    total_found: number;
    new_leads_saved: number;
    duplicates_skipped: number;
    error_message: string | null;
    triggered_by_name: string | null;
}

function StatPill({ value, label, color }: { value: number; label: string; color: string }) {
    return (
        <div className="flex flex-col items-center">
            <span className={`text-sm font-bold ${color}`}>{value}</span>
            <span className="text-[10px] text-gray-400">{label}</span>
        </div>
    );
}

export function ScraperRunsTable() {
    const router = useRouter();

    const { data: runs = [], isLoading, error } = useQuery<RunRow[]>({
        queryKey: ['scraper-runs'],
        queryFn: async () => {
            const res = await fetch('/api/scraper/run?limit=30');
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return json.data;
        },
        // Poll every 4s while there is a running job
        refetchInterval: (query) => {
            const data = query.state.data as RunRow[] | undefined;
            return data?.some((r) => r.status === 'running') ? 4000 : false;
        },
    });

    if (isLoading) {
        return (
            <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                    <div key={i} className="h-16 bg-gray-100 animate-pulse rounded-xl" />
                ))}
            </div>
        );
    }

    if (error) {
        return (
            <p className="text-sm text-red-500 bg-red-50 rounded-xl p-4">
                Failed to load run history.
            </p>
        );
    }

    if (runs.length === 0) {
        return (
            <div className="text-center py-12 text-gray-400">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No scraper runs yet. Click "Run Scraper" to start.</p>
            </div>
        );
    }

    return (
        <div className="overflow-hidden rounded-xl border border-gray-100">
            <table className="w-full text-sm">
                <thead>
                    <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                        <th className="px-4 py-3 text-left font-medium">Run ID</th>
                        <th className="px-4 py-3 text-left font-medium">Status</th>
                        <th className="px-4 py-3 text-left font-medium">Triggered By</th>
                        <th className="px-4 py-3 text-left font-medium">Started</th>
                        <th className="px-4 py-3 text-center font-medium">Results</th>
                        <th className="px-4 py-3 text-right font-medium"></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                    {runs.map((run) => (
                        <tr
                            key={run.id}
                            onClick={() => router.push(`/sales-head/scraper/runs/${run.id}`)}
                            className="hover:bg-gray-50/50 cursor-pointer transition-colors"
                        >
                            <td className="px-4 py-3.5">
                                <span className="font-mono text-xs text-gray-700">{run.id}</span>
                            </td>
                            <td className="px-4 py-3.5">
                                <div className="flex items-center gap-1.5">
                                    {run.status === 'running' && (
                                        <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />
                                    )}
                                    {run.status === 'completed' && (
                                        <CheckCircle className="w-3 h-3 text-green-500" />
                                    )}
                                    {run.status === 'failed' && (
                                        <XCircle className="w-3 h-3 text-red-500" />
                                    )}
                                    <RunStatusBadge status={run.status} />
                                </div>
                            </td>
                            <td className="px-4 py-3.5 text-gray-600">
                                {run.triggered_by_name ?? '—'}
                            </td>
                            <td className="px-4 py-3.5 text-gray-500 text-xs">
                                {fmtDate(run.started_at)}
                            </td>
                            <td className="px-4 py-3.5">
                                <div className="flex items-center justify-center gap-4">
                                    <StatPill value={run.total_found} label="Found" color="text-gray-700" />
                                    <StatPill value={run.new_leads_saved} label="New" color="text-green-600" />
                                    <StatPill value={run.duplicates_skipped} label="Dupes" color="text-orange-500" />
                                </div>
                            </td>
                            <td className="px-4 py-3.5 text-right">
                                <ChevronRight className="w-4 h-4 text-gray-400 ml-auto" />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
