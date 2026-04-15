"use client";

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Play, AlertCircle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScraperRunsTable } from './ScraperRunsTable';
import { QueryManager } from './QueryManager';
import { ScheduleConfig } from './ScheduleConfig';

export function ScraperDashboard() {
    const queryClient = useQueryClient();
    const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
    const [tab, setTab] = useState<'history' | 'queries'>('history');

    const triggerMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch('/api/scraper/run', { method: 'POST' });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? 'Failed to start scraper');
            return json.data as { run_id: string; message: string };
        },
        onSuccess: (data) => {
            setToast({ type: 'success', msg: `Scraper started — Run ID: ${data.run_id}` });
            queryClient.invalidateQueries({ queryKey: ['scraper-runs'] });
            setTimeout(() => setToast(null), 6000);
        },
        onError: (err: Error) => {
            setToast({ type: 'error', msg: err.message });
            setTimeout(() => setToast(null), 8000);
        },
    });

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-teal-50 rounded-xl flex items-center justify-center shadow-sm">
                        <Search className="w-5 h-5 text-teal-600" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-gray-900">Dealer Lead Scraper</h1>
                        <p className="text-sm text-gray-500">
                            Discover 3-wheeler battery dealers from the web automatically
                        </p>
                    </div>
                </div>

                <Button
                    onClick={() => triggerMutation.mutate()}
                    disabled={triggerMutation.isPending}
                    className="bg-teal-600 hover:bg-teal-700 text-white gap-2"
                >
                    <Play className="w-4 h-4" />
                    {triggerMutation.isPending ? 'Starting…' : 'Run Scraper'}
                </Button>
            </div>

            {/* Toast */}
            {toast && (
                <div
                    className={`flex items-start gap-3 p-4 rounded-xl text-sm ${
                        toast.type === 'success'
                            ? 'bg-green-50 text-green-800 border border-green-100'
                            : 'bg-red-50 text-red-800 border border-red-100'
                    }`}
                >
                    {toast.type === 'success' ? (
                        <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    ) : (
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    )}
                    <span>{toast.msg}</span>
                </div>
            )}

            {/* Info card */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-teal-50/60 border border-teal-100 rounded-xl p-4">
                    <p className="text-xs text-teal-600 font-medium mb-0.5">Data Sources</p>
                    <p className="text-sm text-gray-700">JustDial · IndiaMART · Sulekha · Google</p>
                </div>
                <div className="bg-teal-50/60 border border-teal-100 rounded-xl p-4">
                    <p className="text-xs text-teal-600 font-medium mb-0.5">Deduplication</p>
                    <p className="text-sm text-gray-700">Phone · Name + City · Source URL</p>
                </div>
                <div className="bg-teal-50/60 border border-teal-100 rounded-xl p-4">
                    <p className="text-xs text-teal-600 font-medium mb-0.5">Assignment</p>
                    <p className="text-sm text-gray-700">Assign new leads to Sales Managers</p>
                </div>
            </div>

            <ScheduleConfig />

            {/* Tabs */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
                <button
                    onClick={() => setTab('history')}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        tab === 'history' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                    Run History
                </button>
                <button
                    onClick={() => setTab('queries')}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        tab === 'queries' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                    Search Queries
                </button>
            </div>

            {/* Tab content */}
            {tab === 'history' ? (
                <div>
                    <h2 className="text-sm font-semibold text-gray-700 mb-3">Run History</h2>
                    <ScraperRunsTable />
                </div>
            ) : (
                <div>
                    <h2 className="text-sm font-semibold text-gray-700 mb-3">Manage Search Queries</h2>
                    <QueryManager />
                </div>
            )}
        </div>
    );
}
