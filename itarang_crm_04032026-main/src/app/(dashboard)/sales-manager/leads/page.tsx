'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { IntentBadge } from '@/components/leads/intent-badge';
import { StatusBadge } from '@/components/shared/status-badge';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Phone } from 'lucide-react';

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
    intent_reason: string | null;
    phone_quality: string | null;
    ai_managed: boolean | null;
    total_ai_calls: number | null;
    last_call_outcome: string | null;
    last_ai_call_at: string | null;
    conversation_summary: string | null;
    intent_details: any;
    website: string | null;
    google_rating: number | null;
    created_at: string;
}

export default function SalesManagerLeadsPage() {
    const [leads, setLeads] = useState<Lead[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [statusUpdating, setStatusUpdating] = useState<string | null>(null);

    const limit = 20;

    const fetchLeads = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/sales-manager/leads?page=${page}&limit=${limit}`);
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
    }, [page]);

    useEffect(() => {
        fetchLeads();
    }, [fetchLeads]);

    const updateStatus = async (leadId: string, newStatus: string) => {
        setStatusUpdating(leadId);
        try {
            const res = await fetch(`/api/leads/${leadId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lead_status: newStatus }),
            });
            if (res.ok) {
                setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, lead_status: newStatus } : l));
            }
        } catch {
            // ignore
        } finally {
            setStatusUpdating(null);
        }
    };

    const totalPages = Math.ceil(total / limit);

    return (
        <div className="p-8 space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Assigned Leads</h1>
                <p className="text-gray-500 text-sm mt-1">Manage and convert leads assigned to you.</p>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-gray-100 bg-gray-50/50">
                                <th className="w-10 px-4 py-3"></th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Business</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Phone</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">City</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Intent</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">AI Calls</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Last Outcome</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                                <th className="text-left px-4 py-3 font-medium text-gray-500">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={9} className="text-center py-12 text-gray-400">Loading...</td></tr>
                            ) : leads.length === 0 ? (
                                <tr><td colSpan={9} className="text-center py-12 text-gray-400">No assigned leads</td></tr>
                            ) : (
                                leads.map((lead) => (
                                    <React.Fragment key={lead.id}>
                                        <tr className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                                            <td className="px-4 py-3">
                                                <button onClick={() => setExpandedId(expandedId === lead.id ? null : lead.id)}>
                                                    {expandedId === lead.id ? (
                                                        <ChevronUp className="w-4 h-4 text-gray-400" />
                                                    ) : (
                                                        <ChevronDown className="w-4 h-4 text-gray-400" />
                                                    )}
                                                </button>
                                            </td>
                                            <td className="px-4 py-3">
                                                <Link href={`/leads/${lead.id}`} className="font-medium text-gray-900 hover:text-blue-600">
                                                    {lead.business_name || lead.owner_name}
                                                </Link>
                                            </td>
                                            <td className="px-4 py-3 text-gray-700">{lead.phone || lead.owner_contact}</td>
                                            <td className="px-4 py-3 text-gray-600">{lead.city || '—'}</td>
                                            <td className="px-4 py-3">
                                                <IntentBadge band={lead.intent_band} score={lead.intent_score} />
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="text-gray-700">{lead.total_ai_calls || 0}</span>
                                            </td>
                                            <td className="px-4 py-3 text-xs text-gray-600">{lead.last_call_outcome || '—'}</td>
                                            <td className="px-4 py-3">
                                                <select
                                                    value={lead.lead_status}
                                                    onChange={(e) => updateStatus(lead.id, e.target.value)}
                                                    disabled={statusUpdating === lead.id}
                                                    className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none"
                                                >
                                                    <option value="new">New</option>
                                                    <option value="assigned">Assigned</option>
                                                    <option value="contacted">Contacted</option>
                                                    <option value="qualified">Qualified</option>
                                                    <option value="converted">Converted</option>
                                                    <option value="lost">Lost</option>
                                                </select>
                                            </td>
                                            <td className="px-4 py-3">
                                                <Link href={`/leads/${lead.id}`}>
                                                    <Button size="sm" variant="ghost">View</Button>
                                                </Link>
                                            </td>
                                        </tr>
                                        {expandedId === lead.id && (
                                            <tr className="bg-gray-50/50">
                                                <td colSpan={9} className="px-8 py-4">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                                        <div>
                                                            <h4 className="font-medium text-gray-700 mb-2">Conversation Summary</h4>
                                                            <p className="text-gray-600 text-xs leading-relaxed">
                                                                {lead.conversation_summary || 'No conversation yet.'}
                                                            </p>
                                                        </div>
                                                        <div>
                                                            <h4 className="font-medium text-gray-700 mb-2">Intent Details</h4>
                                                            {lead.intent_details ? (
                                                                <div className="space-y-1 text-xs text-gray-600">
                                                                    {lead.intent_details.reason && <p><span className="font-medium">Reason:</span> {lead.intent_details.reason}</p>}
                                                                    {lead.intent_details.objections && <p><span className="font-medium">Objections:</span> {lead.intent_details.objections}</p>}
                                                                    {lead.intent_details.suggested_pitch && <p><span className="font-medium">Suggested Pitch:</span> {lead.intent_details.suggested_pitch}</p>}
                                                                </div>
                                                            ) : (
                                                                <p className="text-gray-400 text-xs">No intent data yet.</p>
                                                            )}
                                                        </div>
                                                        {lead.website && (
                                                            <div>
                                                                <h4 className="font-medium text-gray-700 mb-1">Website</h4>
                                                                <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">{lead.website}</a>
                                                            </div>
                                                        )}
                                                        {lead.last_ai_call_at && (
                                                            <div>
                                                                <h4 className="font-medium text-gray-700 mb-1">Last AI Call</h4>
                                                                <p className="text-xs text-gray-600">{new Date(lead.last_ai_call_at).toLocaleString()}</p>
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
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
        </div>
    );
}
