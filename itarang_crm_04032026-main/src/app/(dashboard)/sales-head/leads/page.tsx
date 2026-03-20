'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { IntentBadge } from '@/components/leads/intent-badge';
import { ScrapeModal } from '@/components/leads/scrape-modal';
import { BulkAssignDropdown } from '@/components/leads/bulk-assign-dropdown';
import { StatusBadge } from '@/components/shared/status-badge';
import Link from 'next/link';
import { Search, Phone, ChevronLeft, ChevronRight } from 'lucide-react';

interface Lead {
    id: string;
    business_name: string;
    owner_name: string;
    owner_contact: string;
    phone: string;
    city: string | null;
    state: string | null;
    lead_source: string | null;
    interest_level: string | null;
    lead_status: string;
    intent_score: number | null;
    intent_band: string | null;
    google_rating: number | null;
    google_ratings_count: number | null;
    phone_quality: string | null;
    do_not_call: boolean | null;
    ai_managed: boolean | null;
    total_ai_calls: number | null;
    last_call_outcome: string | null;
    conversation_summary: string | null;
    scraped_at: string | null;
    created_at: string;
    // Assigned tab only
    assigned_owner_id?: string;
    assigned_owner_name?: string;
    assigned_at?: string;
}

export default function SalesHeadLeadsPage() {
    const [tab, setTab] = useState<'unassigned' | 'assigned'>('unassigned');
    const [leads, setLeads] = useState<Lead[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [scrapeOpen, setScrapeOpen] = useState(false);
    const [aiCallLoading, setAiCallLoading] = useState(false);

    // Filters
    const [intentBand, setIntentBand] = useState('');
    const [city, setCity] = useState('');
    const [source, setSource] = useState('');

    const limit = 20;

    const fetchLeads = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ tab, page: String(page), limit: String(limit) });
            if (intentBand) params.set('intent_band', intentBand);
            if (city) params.set('city', city);
            if (source) params.set('source', source);

            const res = await fetch(`/api/sales-head/leads?${params}`);
            const json = await res.json();
            if (json.success) {
                setLeads(json.data.data || []);
                setTotal(json.data.total || 0);
            }
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, [tab, page, intentBand, city, source]);

    useEffect(() => {
        fetchLeads();
    }, [fetchLeads]);

    useEffect(() => {
        setPage(1);
        setSelectedIds([]);
    }, [tab, intentBand, city, source]);

    const toggleSelect = (id: string) => {
        setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
    };

    const toggleAll = () => {
        if (selectedIds.length === leads.length) {
            setSelectedIds([]);
        } else {
            setSelectedIds(leads.map((l) => l.id));
        }
    };

    const handleBulkAiCall = async () => {
        if (selectedIds.length === 0) return;
        setAiCallLoading(true);
        try {
            const res = await fetch('/api/leads/bulk-ai-call', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadIds: selectedIds }),
            });
            const data = await res.json();
            if (data.success) {
                alert(`AI Call: ${data.data.queued} queued, ${data.data.skipped} skipped`);
                setSelectedIds([]);
                fetchLeads();
            }
        } catch {
            // ignore
        } finally {
            setAiCallLoading(false);
        }
    };

    const totalPages = Math.ceil(total / limit);

    return (
        <div className="p-8 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Lead Discovery</h1>
                    <p className="text-gray-500 text-sm mt-1">Discover, score, and assign leads to your sales team.</p>
                </div>
                <Button onClick={() => setScrapeOpen(true)}>
                    <Search className="w-4 h-4 mr-2" /> Scrape from Google Maps
                </Button>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
                <button
                    onClick={() => setTab('unassigned')}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'unassigned' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                    Unassigned Leads
                </button>
                <button
                    onClick={() => setTab('assigned')}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'assigned' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                    Assigned Leads
                </button>
            </div>

            {/* Filters */}
            <div className="flex gap-3 items-center flex-wrap">
                <Select value={intentBand} onChange={(e) => setIntentBand(e.target.value)} className="w-40">
                    <option value="">All Intent</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                </Select>
                <Input
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Filter by city..."
                    className="w-44"
                />
                <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-44">
                    <option value="">All Sources</option>
                    <option value="google_maps">Google Maps</option>
                    <option value="website">Website</option>
                    <option value="referral">Referral</option>
                    <option value="cold_call">Cold Call</option>
                    <option value="event">Event</option>
                </Select>
                <span className="text-sm text-gray-400 ml-auto">{total} leads</span>
            </div>

            {/* Bulk Actions */}
            {selectedIds.length > 0 && (
                <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3">
                    <span className="text-sm font-medium text-blue-700">{selectedIds.length} selected</span>
                    <BulkAssignDropdown selectedLeadIds={selectedIds} onAssigned={() => { setSelectedIds([]); fetchLeads(); }} />
                    <Button size="sm" variant="outline" onClick={handleBulkAiCall} disabled={aiCallLoading}>
                        <Phone className="w-3.5 h-3.5 mr-1.5" />
                        {aiCallLoading ? 'Triggering...' : 'Trigger AI Call'}
                    </Button>
                </div>
            )}

            {/* Table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-gray-100 bg-gray-50/50">
                                <th className="w-10 px-4 py-3">
                                    <input
                                        type="checkbox"
                                        checked={leads.length > 0 && selectedIds.length === leads.length}
                                        onChange={toggleAll}
                                        className="rounded border-gray-300"
                                    />
                                </th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Business</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Phone</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">City / State</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Intent</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Source</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Rating</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">AI Status</th>
                                {tab === 'assigned' && (
                                    <th className="text-left px-4 py-3 font-medium text-gray-500">Assigned To</th>
                                )}
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={10} className="text-center py-12 text-gray-400">Loading...</td></tr>
                            ) : leads.length === 0 ? (
                                <tr><td colSpan={10} className="text-center py-12 text-gray-400">No leads found</td></tr>
                            ) : (
                                leads.map((lead) => (
                                    <tr key={lead.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                                        <td className="px-4 py-3">
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.includes(lead.id)}
                                                onChange={() => toggleSelect(lead.id)}
                                                className="rounded border-gray-300"
                                            />
                                        </td>
                                        <td className="px-4 py-3">
                                            <Link href={`/leads/${lead.id}`} className="font-medium text-gray-900 hover:text-blue-600">
                                                {lead.business_name || lead.owner_name}
                                            </Link>
                                            {lead.owner_name && lead.business_name && (
                                                <p className="text-xs text-gray-400">{lead.owner_name}</p>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="text-gray-700">{lead.phone || lead.owner_contact}</span>
                                            {lead.phone_quality && lead.phone_quality !== 'valid' && (
                                                <span className="ml-1 text-[10px] text-red-500 uppercase">{lead.phone_quality}</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-gray-600">
                                            {[lead.city, lead.state].filter(Boolean).join(', ') || '—'}
                                        </td>
                                        <td className="px-4 py-3">
                                            <IntentBadge band={lead.intent_band} score={lead.intent_score} />
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="text-xs text-gray-500">{lead.lead_source || '—'}</span>
                                        </td>
                                        <td className="px-4 py-3">
                                            {lead.google_rating ? (
                                                <span className="text-gray-700">{lead.google_rating} <span className="text-xs text-gray-400">({lead.google_ratings_count})</span></span>
                                            ) : '—'}
                                        </td>
                                        <td className="px-4 py-3">
                                            {lead.ai_managed ? (
                                                <span className="text-xs text-blue-600 font-medium">
                                                    {lead.total_ai_calls || 0} calls
                                                    {lead.last_call_outcome && <span className="text-gray-400"> · {lead.last_call_outcome}</span>}
                                                </span>
                                            ) : (
                                                <span className="text-xs text-gray-400">—</span>
                                            )}
                                        </td>
                                        {tab === 'assigned' && (
                                            <td className="px-4 py-3 text-xs text-gray-600">
                                                {lead.assigned_owner_name || '—'}
                                            </td>
                                        )}
                                        <td className="px-4 py-3">
                                            <StatusBadge status={lead.lead_status} />
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
                        <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
                        <div className="flex gap-1">
                            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                                <ChevronLeft className="w-4 h-4" />
                            </Button>
                            <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                                <ChevronRight className="w-4 h-4" />
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            {/* Scrape Modal */}
            <ScrapeModal open={scrapeOpen} onClose={() => setScrapeOpen(false)} onComplete={fetchLeads} />
        </div>
    );
}
