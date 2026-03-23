"use client";

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, MapPin, ExternalLink, UserPlus } from 'lucide-react';
import { ExplorationStatusBadge } from './ExplorationStatusBadge';
import { AssignLeadModal } from './AssignLeadModal';
import { Button } from '@/components/ui/button';

interface LeadRow {
    id: string;
    dealer_name: string;
    phone: string | null;
    location_city: string | null;
    location_state: string | null;
    source_url: string | null;
    exploration_status: string;
    assigned_to: string | null;
    assigned_to_name: string | null;
    assigned_at: string | null;
    created_at: string;
    scraper_run_id: string;
}

interface Props {
    runId?: string;          // optional filter by run
    showAssignButton?: boolean;
}

export function ScrapedLeadsTable({ runId, showAssignButton = true }: Props) {
    const [assignTarget, setAssignTarget] = useState<{ id: string; name: string } | null>(null);

    const queryKey = ['scraper-leads', runId ?? 'all'];

    const { data: leads = [], isLoading, error, refetch } = useQuery<LeadRow[]>({
        queryKey,
        queryFn: async () => {
            const params = new URLSearchParams({ limit: '100' });
            if (runId) params.set('run_id', runId);
            const res = await fetch(`/api/scraper/leads?${params}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return json.data;
        },
    });

    if (isLoading) {
        return (
            <div className="space-y-2">
                {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-14 bg-gray-100 animate-pulse rounded-xl" />
                ))}
            </div>
        );
    }

    if (error) {
        return (
            <p className="text-sm text-red-500 bg-red-50 rounded-xl p-4">
                Failed to load leads.
            </p>
        );
    }

    if (leads.length === 0) {
        return (
            <div className="text-center py-10 text-gray-400 text-sm">
                No scraped leads found.
            </div>
        );
    }

    return (
        <>
            <div className="overflow-hidden rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                            <th className="px-4 py-3 text-left font-medium">Dealer</th>
                            <th className="px-4 py-3 text-left font-medium">Phone</th>
                            <th className="px-4 py-3 text-left font-medium">Location</th>
                            <th className="px-4 py-3 text-left font-medium">Source</th>
                            <th className="px-4 py-3 text-left font-medium">Status</th>
                            <th className="px-4 py-3 text-left font-medium">Assigned To</th>
                            {showAssignButton && (
                                <th className="px-4 py-3 text-right font-medium">Action</th>
                            )}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                        {leads.map((lead) => (
                            <tr key={lead.id} className="hover:bg-gray-50/50 transition-colors">
                                <td className="px-4 py-3.5">
                                    <span className="font-medium text-gray-900">{lead.dealer_name}</span>
                                </td>
                                <td className="px-4 py-3.5">
                                    {lead.phone ? (
                                        <a
                                            href={`tel:${lead.phone}`}
                                            className="flex items-center gap-1.5 text-teal-600 hover:text-teal-700"
                                        >
                                            <Phone className="w-3.5 h-3.5" />
                                            <span className="text-xs">{lead.phone}</span>
                                        </a>
                                    ) : (
                                        <span className="text-gray-400 text-xs">—</span>
                                    )}
                                </td>
                                <td className="px-4 py-3.5">
                                    {lead.location_city || lead.location_state ? (
                                        <span className="flex items-center gap-1 text-gray-600 text-xs">
                                            <MapPin className="w-3.5 h-3.5 text-gray-400" />
                                            {[lead.location_city, lead.location_state]
                                                .filter(Boolean)
                                                .join(', ')}
                                        </span>
                                    ) : (
                                        <span className="text-gray-400 text-xs">—</span>
                                    )}
                                </td>
                                <td className="px-4 py-3.5">
                                    {lead.source_url ? (
                                        <a
                                            href={lead.source_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-1 text-blue-500 hover:text-blue-700 text-xs"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            <ExternalLink className="w-3 h-3" />
                                            View Source
                                        </a>
                                    ) : (
                                        <span className="text-gray-400 text-xs">—</span>
                                    )}
                                </td>
                                <td className="px-4 py-3.5">
                                    <ExplorationStatusBadge status={lead.exploration_status} />
                                </td>
                                <td className="px-4 py-3.5 text-gray-600 text-xs">
                                    {lead.assigned_to_name ?? (
                                        <span className="text-gray-400">Unassigned</span>
                                    )}
                                </td>
                                {showAssignButton && (
                                    <td className="px-4 py-3.5 text-right">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="text-xs h-7 px-2.5"
                                            onClick={() =>
                                                setAssignTarget({ id: lead.id, name: lead.dealer_name })
                                            }
                                        >
                                            <UserPlus className="w-3.5 h-3.5 mr-1" />
                                            {lead.assigned_to ? 'Reassign' : 'Assign'}
                                        </Button>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {assignTarget && (
                <AssignLeadModal
                    leadId={assignTarget.id}
                    dealerName={assignTarget.name}
                    onClose={() => setAssignTarget(null)}
                    onSuccess={() => refetch()}
                />
            )}
        </>
    );
}
