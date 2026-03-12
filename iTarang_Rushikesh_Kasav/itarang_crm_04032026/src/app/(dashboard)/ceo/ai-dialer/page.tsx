'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOff, RefreshCw, Clock, Brain, Loader2, AlertTriangle, User, ChevronDown, ChevronUp, Power } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tab = 'queue' | 'assigned' | 'history';

export default function AIDialerPage() {
    const [activeTab, setActiveTab] = useState<Tab>('queue');
    const queryClient = useQueryClient();

    const { data: settingsData } = useQuery({
        queryKey: ['ai-dialer-settings'],
        queryFn: async () => {
            const res = await fetch('/api/ceo/ai-dialer/settings');
            if (!res.ok) return { enabled: true };
            return (await res.json()).data;
        },
    });

    const toggleMutation = useMutation({
        mutationFn: async (enabled: boolean) => {
            const res = await fetch('/api/ceo/ai-dialer/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-dialer-settings'] }),
    });

    const aiEnabled = settingsData?.enabled !== false;

    return (
        <div className="space-y-6 pb-12">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">AI Dialer (Bolna)</h1>
                    <p className="text-sm text-gray-500 mt-1">AI-managed lead qualification and call scheduling</p>
                </div>
                <div className="flex items-center gap-3">
                    <span className={cn('text-sm font-medium', aiEnabled ? 'text-green-700' : 'text-gray-500')}>
                        AI Caller {aiEnabled ? 'ON' : 'OFF'}
                    </span>
                    <button
                        onClick={() => toggleMutation.mutate(!aiEnabled)}
                        disabled={toggleMutation.isPending}
                        className={cn(
                            'relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2',
                            aiEnabled ? 'bg-green-500' : 'bg-gray-300'
                        )}
                    >
                        <span
                            className={cn(
                                'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform',
                                aiEnabled ? 'translate-x-6' : 'translate-x-1'
                            )}
                        />
                    </button>
                </div>
            </div>

            {!aiEnabled && (
                <div className="flex items-center gap-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
                    <Power className="w-4 h-4 text-amber-600 shrink-0" />
                    <p className="text-sm text-amber-800">
                        AI automation is paused. No automated calls will be placed. Manual &ldquo;Call Now&rdquo; is still available.
                    </p>
                </div>
            )}

            {/* Tab Bar */}
            <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl">
                {([
                    { id: 'queue' as Tab, label: 'Call Queue' },
                    { id: 'assigned' as Tab, label: 'Assigned Leads' },
                    { id: 'history' as Tab, label: 'Call History' },
                ]).map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                            'px-4 py-2.5 rounded-lg text-sm font-medium transition-all',
                            activeTab === tab.id ? 'bg-white text-brand-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                        )}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {activeTab === 'queue' && <QueueTab />}
            {activeTab === 'assigned' && <AssignedTab />}
            {activeTab === 'history' && <HistoryTab />}
        </div>
    );
}

function QueueTab() {
    const queryClient = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ['ai-dialer-queue'],
        queryFn: async () => {
            const res = await fetch('/api/ceo/ai-dialer/queue?limit=50');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
        refetchInterval: 30000,
    });

    const callMutation = useMutation({
        mutationFn: async (leadId: string) => {
            const res = await fetch('/api/ceo/ai-dialer/call', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadId }),
            });
            if (!res.ok) throw new Error('Failed');
            return res.json();
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-dialer-queue'] }),
    });

    const takeoverMutation = useMutation({
        mutationFn: async (leadId: string) => {
            const res = await fetch('/api/ceo/ai-dialer/takeover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadId, takeover: true }),
            });
            if (!res.ok) throw new Error('Failed');
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-dialer-queue'] }),
    });

    if (isLoading) return <LoadingState />;

    const queue = Array.isArray(data) ? data : [];

    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">Prioritized Call Queue</h3>
                <span className="text-xs text-gray-500">{queue.length} leads</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                            <th className="px-4 py-3 font-medium">Lead</th>
                            <th className="px-4 py-3 font-medium">Phone</th>
                            <th className="px-4 py-3 font-medium">Intent Score</th>
                            <th className="px-4 py-3 font-medium">Priority</th>
                            <th className="px-4 py-3 font-medium">Last Status</th>
                            <th className="px-4 py-3 font-medium">Next Call</th>
                            <th className="px-4 py-3 font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {queue.length === 0 ? (
                            <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No leads in queue. Assign leads from the Leads page.</td></tr>
                        ) : queue.map((lead: Record<string, unknown>) => (
                            <tr key={String(lead.id)} className="border-b border-gray-50 hover:bg-gray-50/50">
                                <td className="px-4 py-3">
                                    <div>
                                        <p className="font-medium text-gray-900">{String(lead.full_name || lead.owner_name || '-')}</p>
                                        <p className="text-xs text-gray-400">{String(lead.reference_id || lead.id)}</p>
                                    </div>
                                </td>
                                <td className="px-4 py-3 text-gray-600">{String(lead.phone || lead.owner_contact || '-')}</td>
                                <td className="px-4 py-3"><IntentBadge score={Number(lead.intent_score || 0)} /></td>
                                <td className="px-4 py-3 font-mono text-gray-600">{String(lead.call_priority || 0)}</td>
                                <td className="px-4 py-3"><StatusBadge status={String(lead.last_call_status || 'none')} /></td>
                                <td className="px-4 py-3 text-xs text-gray-500">
                                    {lead.next_call_at ? new Date(String(lead.next_call_at)).toLocaleString() : '-'}
                                </td>
                                <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => callMutation.mutate(String(lead.id))}
                                            disabled={callMutation.isPending}
                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-50 rounded-lg hover:bg-green-100"
                                        >
                                            <Phone className="w-3 h-3" /> Call
                                        </button>
                                        <button
                                            onClick={() => takeoverMutation.mutate(String(lead.id))}
                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100"
                                        >
                                            <User className="w-3 h-3" /> Manual
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Expandable conversation summaries */}
            {queue.length > 0 && (
                <div className="p-4 border-t border-gray-100">
                    <h4 className="text-xs font-semibold text-gray-500 mb-2">Lead Insights</h4>
                    <div className="space-y-2">
                        {queue.slice(0, 5).map((lead: Record<string, unknown>) => (
                            <LeadInsight key={String(lead.id)} lead={lead} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function AssignedTab() {
    const queryClient = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ['ai-dialer-assigned'],
        queryFn: async () => {
            const res = await fetch('/api/ceo/ai-dialer/queue?limit=100');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    const takeoverMutation = useMutation({
        mutationFn: async ({ leadId, takeover }: { leadId: string; takeover: boolean }) => {
            const res = await fetch('/api/ceo/ai-dialer/takeover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadId, takeover }),
            });
            if (!res.ok) throw new Error('Failed');
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-dialer-assigned'] }),
    });

    const scoreMutation = useMutation({
        mutationFn: async (leadId: string) => {
            const res = await fetch('/api/ceo/ai-dialer/score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadId }),
            });
            if (!res.ok) throw new Error('Failed');
            return res.json();
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-dialer-assigned'] }),
    });

    if (isLoading) return <LoadingState />;

    const assigned = Array.isArray(data) ? data : [];

    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="p-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">AI-Managed Leads</h3>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                            <th className="px-4 py-3 font-medium">Lead</th>
                            <th className="px-4 py-3 font-medium">Intent Score</th>
                            <th className="px-4 py-3 font-medium">Intent Reason</th>
                            <th className="px-4 py-3 font-medium">Total Calls</th>
                            <th className="px-4 py-3 font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {assigned.length === 0 ? (
                            <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No assigned leads</td></tr>
                        ) : assigned.map((lead: Record<string, unknown>) => (
                            <tr key={String(lead.id)} className="border-b border-gray-50">
                                <td className="px-4 py-3 font-medium text-gray-900">{String(lead.full_name || lead.owner_name || '-')}</td>
                                <td className="px-4 py-3"><IntentBadge score={Number(lead.intent_score || 0)} /></td>
                                <td className="px-4 py-3 text-xs text-gray-500 max-w-xs truncate">{String(lead.intent_reason || '-')}</td>
                                <td className="px-4 py-3 text-gray-600">{String(lead.total_ai_calls || 0)}</td>
                                <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => scoreMutation.mutate(String(lead.id))}
                                            disabled={scoreMutation.isPending}
                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100"
                                        >
                                            <Brain className="w-3 h-3" /> Re-Score
                                        </button>
                                        <button
                                            onClick={() => takeoverMutation.mutate({ leadId: String(lead.id), takeover: true })}
                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100"
                                        >
                                            <PhoneOff className="w-3 h-3" /> Takeover
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function HistoryTab() {
    const { data, isLoading } = useQuery({
        queryKey: ['ai-dialer-history'],
        queryFn: async () => {
            // Fetch from queue which includes call info
            const res = await fetch('/api/ceo/ai-dialer/queue?limit=50');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });

    if (isLoading) return <LoadingState />;

    const history = Array.isArray(data) ? data.filter((l: Record<string, unknown>) => Number(l.total_ai_calls) > 0) : [];

    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="p-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">Call History</h3>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                            <th className="px-4 py-3 font-medium">Lead</th>
                            <th className="px-4 py-3 font-medium">Phone</th>
                            <th className="px-4 py-3 font-medium">Total Calls</th>
                            <th className="px-4 py-3 font-medium">Last Call</th>
                            <th className="px-4 py-3 font-medium">Status</th>
                            <th className="px-4 py-3 font-medium">Intent</th>
                            <th className="px-4 py-3 font-medium">Summary</th>
                        </tr>
                    </thead>
                    <tbody>
                        {history.length === 0 ? (
                            <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No call history</td></tr>
                        ) : history.map((lead: Record<string, unknown>) => (
                            <tr key={String(lead.id)} className="border-b border-gray-50">
                                <td className="px-4 py-3 font-medium text-gray-900">{String(lead.full_name || lead.owner_name || '-')}</td>
                                <td className="px-4 py-3 text-gray-600">{String(lead.phone || lead.owner_contact || '-')}</td>
                                <td className="px-4 py-3 font-mono">{String(lead.total_ai_calls || 0)}</td>
                                <td className="px-4 py-3 text-xs text-gray-500">{lead.last_ai_call_at ? new Date(String(lead.last_ai_call_at)).toLocaleString() : '-'}</td>
                                <td className="px-4 py-3"><StatusBadge status={String(lead.last_call_status || 'none')} /></td>
                                <td className="px-4 py-3"><IntentBadge score={Number(lead.intent_score || 0)} /></td>
                                <td className="px-4 py-3 text-xs text-gray-500 max-w-xs truncate">{String(lead.conversation_summary || '-')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ─── Shared Components ───────────────────────────────────────────────────────

function IntentBadge({ score }: { score: number }) {
    const color = score >= 70 ? 'bg-green-100 text-green-700' : score >= 40 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
    return (
        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold', color)}>
            {score}
        </span>
    );
}

function StatusBadge({ status }: { status: string }) {
    const colors: Record<string, string> = {
        initiated: 'bg-blue-100 text-blue-700',
        completed: 'bg-green-100 text-green-700',
        failed: 'bg-red-100 text-red-700',
        none: 'bg-gray-100 text-gray-500',
    };
    return (
        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', colors[status] || colors.none)}>
            {status}
        </span>
    );
}

function LoadingState() {
    return (
        <div className="flex items-center justify-center h-48">
            <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
        </div>
    );
}

function LeadInsight({ lead }: { lead: Record<string, unknown> }) {
    const [open, setOpen] = useState(false);
    const summary = String(lead.conversation_summary || '');
    const reason = String(lead.intent_reason || '');
    if (!summary && !reason) return null;

    return (
        <div className="border border-gray-100 rounded-lg">
            <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-3 py-2 text-xs">
                <span className="font-medium text-gray-700">{String(lead.full_name || lead.owner_name || '-')}</span>
                {open ? <ChevronUp className="w-3 h-3 text-gray-400" /> : <ChevronDown className="w-3 h-3 text-gray-400" />}
            </button>
            {open && (
                <div className="px-3 pb-3 space-y-1">
                    {reason && <p className="text-xs text-gray-600"><strong>Reason:</strong> {reason}</p>}
                    {summary && <p className="text-xs text-gray-500">{summary}</p>}
                </div>
            )}
        </div>
    );
}
