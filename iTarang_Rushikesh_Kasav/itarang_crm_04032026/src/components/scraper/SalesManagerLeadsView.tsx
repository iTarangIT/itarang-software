"use client";

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone, MapPin, ExternalLink, ChevronDown, ChevronUp, Save } from 'lucide-react';
import { ExplorationStatusBadge } from './ExplorationStatusBadge';
import { QualityScoreBadge } from './QualityScoreBadge';
import { Button } from '@/components/ui/button';
import type { ExplorationStatus } from '@/types/scraper';

interface LeadRow {
    id: string;
    dealer_name: string;
    phone: string | null;
    location_city: string | null;
    location_state: string | null;
    source_url: string | null;
    exploration_status: string;
    exploration_notes: string | null;
    assigned_at: string | null;
    created_at: string;
    converted_lead_id: string | null;
    email: string | null;
    gst_number: string | null;
    business_type: string | null;
    products_sold: string | null;
    website: string | null;
    quality_score: number | null;
    phone_valid: boolean | null;
}

function LeadDetailDrawer({
    lead,
    onClose,
}: {
    lead: LeadRow;
    onClose: () => void;
}) {
    const queryClient = useQueryClient();
    const [notes, setNotes] = useState(lead.exploration_notes ?? '');
    const [status, setStatus] = useState<ExplorationStatus>(
        lead.exploration_status as ExplorationStatus
    );
    const [saved, setSaved] = useState(false);

    const mutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/scraper/leads/${lead.id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ exploration_status: status, exploration_notes: notes }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? 'Failed to update');
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['scraper-leads-manager'] });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        },
    });

    const statusOptions: { value: ExplorationStatus; label: string }[] = [
        { value: 'assigned', label: 'Assigned (not started)' },
        { value: 'exploring', label: 'Exploring' },
        { value: 'explored', label: 'Explored' },
        { value: 'not_interested', label: 'Not Interested' },
    ];

    return (
        <div className="border border-gray-100 rounded-xl bg-gray-50/50 p-4 mt-1 space-y-4">
            {/* Contact info */}
            <div className="grid grid-cols-2 gap-3 text-sm">
                {lead.phone && (
                    <div>
                        <p className="text-xs text-gray-400 mb-0.5">Phone</p>
                        <a
                            href={`tel:${lead.phone}`}
                            className="text-teal-600 flex items-center gap-1"
                        >
                            <Phone className="w-3.5 h-3.5" />
                            {lead.phone}
                            {lead.phone_valid === false && (
                                <span className="text-xs text-orange-500 ml-1">(unverified)</span>
                            )}
                        </a>
                    </div>
                )}
                {(lead.location_city || lead.location_state) && (
                    <div>
                        <p className="text-xs text-gray-400 mb-0.5">Location</p>
                        <span className="flex items-center gap-1 text-gray-700">
                            <MapPin className="w-3.5 h-3.5 text-gray-400" />
                            {[lead.location_city, lead.location_state].filter(Boolean).join(', ')}
                        </span>
                    </div>
                )}
                {lead.source_url && (
                    <div className="col-span-2">
                        <p className="text-xs text-gray-400 mb-0.5">Source</p>
                        <a
                            href={lead.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-blue-500 text-xs"
                        >
                            <ExternalLink className="w-3 h-3" />
                            {lead.source_url.slice(0, 60)}…
                        </a>
                    </div>
                )}
                {lead.email && (
                    <div>
                        <p className="text-xs text-gray-400 mb-0.5">Email</p>
                        <a href={`mailto:${lead.email}`} className="text-teal-600 text-sm">{lead.email}</a>
                    </div>
                )}
                {lead.gst_number && (
                    <div>
                        <p className="text-xs text-gray-400 mb-0.5">GST Number</p>
                        <span className="text-sm text-gray-700">{lead.gst_number}</span>
                    </div>
                )}
                {lead.business_type && (
                    <div>
                        <p className="text-xs text-gray-400 mb-0.5">Business Type</p>
                        <span className="text-sm text-gray-700 capitalize">{lead.business_type}</span>
                    </div>
                )}
                {lead.website && (
                    <div>
                        <p className="text-xs text-gray-400 mb-0.5">Website</p>
                        <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-blue-500 text-sm">{lead.website}</a>
                    </div>
                )}
                {lead.products_sold && (
                    <div className="col-span-2">
                        <p className="text-xs text-gray-400 mb-0.5">Products</p>
                        <span className="text-sm text-gray-700">{lead.products_sold}</span>
                    </div>
                )}
            </div>

            {/* Status update */}
            <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                    Exploration Status
                </label>
                <div className="flex flex-wrap gap-2">
                    {statusOptions.map((opt) => (
                        <button
                            key={opt.value}
                            onClick={() => setStatus(opt.value)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                                status === opt.value
                                    ? 'bg-teal-600 text-white border-teal-600'
                                    : 'bg-white text-gray-600 border-gray-200 hover:border-teal-400'
                            }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Notes */}
            <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                    Exploration Notes
                </label>
                <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    placeholder="Add notes about this dealer…"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
                />
            </div>

            {mutation.isError && (
                <p className="text-xs text-red-600">
                    {(mutation.error as Error).message}
                </p>
            )}

            <div className="flex gap-2">
                <Button
                    size="sm"
                    variant="outline"
                    onClick={onClose}
                    className="text-xs"
                >
                    Close
                </Button>
                <Button
                    size="sm"
                    className="bg-teal-600 hover:bg-teal-700 text-white text-xs gap-1.5"
                    onClick={() => mutation.mutate()}
                    disabled={mutation.isPending}
                >
                    <Save className="w-3.5 h-3.5" />
                    {saved ? 'Saved!' : mutation.isPending ? 'Saving…' : 'Save'}
                </Button>
                {(lead.exploration_status === 'explored' || lead.exploration_status === 'exploring') && !lead.converted_lead_id && (
                    <Button
                        size="sm"
                        className="bg-blue-600 hover:bg-blue-700 text-white text-xs gap-1.5 ml-auto"
                        onClick={() => {
                            const params = new URLSearchParams({
                                from_scraped: lead.id,
                                name: lead.dealer_name,
                                phone: lead.phone ?? '',
                                city: lead.location_city ?? '',
                                state: lead.location_state ?? '',
                            });
                            window.open(`/dealer-portal/leads/new?${params}`, '_blank');
                        }}
                    >
                        Convert to CRM Lead
                    </Button>
                )}
                {lead.converted_lead_id && (
                    <a
                        href={`/dealer-portal/leads/${lead.converted_lead_id}/kyc`}
                        className="text-xs text-blue-600 underline ml-auto self-center"
                    >
                        View CRM Lead
                    </a>
                )}
            </div>
        </div>
    );
}

export function SalesManagerLeadsView() {
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState('');

    const { data: leads = [], isLoading } = useQuery<LeadRow[]>({
        queryKey: ['scraper-leads-manager', statusFilter],
        queryFn: async () => {
            const params = new URLSearchParams({ limit: '100' });
            if (statusFilter) params.set('status', statusFilter);
            const res = await fetch(`/api/scraper/leads?${params}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return json.data;
        },
    });

    const filterOptions = [
        { value: '', label: 'All' },
        { value: 'assigned', label: 'Assigned' },
        { value: 'exploring', label: 'Exploring' },
        { value: 'explored', label: 'Explored' },
        { value: 'not_interested', label: 'Not Interested' },
    ];

    return (
        <div className="space-y-5">
            {/* Header */}
            <div>
                <h1 className="text-xl font-bold text-gray-900">Scraped Dealer Leads</h1>
                <p className="text-sm text-gray-500">Leads assigned to you for exploration</p>
            </div>

            {/* Filters */}
            <div className="flex gap-2 flex-wrap">
                {filterOptions.map((opt) => (
                    <button
                        key={opt.value}
                        onClick={() => setStatusFilter(opt.value)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                            statusFilter === opt.value
                                ? 'bg-teal-600 text-white border-teal-600'
                                : 'bg-white text-gray-600 border-gray-200 hover:border-teal-400'
                        }`}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {/* List */}
            {isLoading ? (
                <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-16 bg-gray-100 animate-pulse rounded-xl" />
                    ))}
                </div>
            ) : leads.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">
                    No leads found{statusFilter ? ` with status "${statusFilter}"` : ''}.
                </div>
            ) : (
                <div className="space-y-2">
                    {leads.map((lead) => {
                        const isOpen = expandedId === lead.id;
                        return (
                            <div key={lead.id} className="bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm">
                                <button
                                    onClick={() =>
                                        setExpandedId(isOpen ? null : lead.id)
                                    }
                                    className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-gray-50/50 transition-colors"
                                >
                                    <div className="flex items-center gap-4">
                                        <div>
                                            <p className="font-medium text-gray-900 text-sm">
                                                {lead.dealer_name}
                                            </p>
                                            <p className="text-xs text-gray-400 mt-0.5">
                                                {[lead.location_city, lead.location_state]
                                                    .filter(Boolean)
                                                    .join(', ') || 'Location unknown'}
                                            </p>
                                        </div>
                                        <ExplorationStatusBadge status={lead.exploration_status} />
                                        <QualityScoreBadge score={lead.quality_score} />
                                    </div>
                                    {isOpen ? (
                                        <ChevronUp className="w-4 h-4 text-gray-400" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-gray-400" />
                                    )}
                                </button>

                                {isOpen && (
                                    <div className="px-4 pb-4">
                                        <LeadDetailDrawer
                                            lead={lead}
                                            onClose={() => setExpandedId(null)}
                                        />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
