import { createClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { requireAuth } from '@/lib/auth-utils';
import { Plus } from 'lucide-react';
import { CallButton } from '@/components/leads/call-button';
import { AIDialerControls, AIStatusBadges } from '@/components/leads/ai-dialer-controls';

export const dynamic = 'force-dynamic';

export default async function LeadsPage() {
    const user = await requireAuth();

    const supabase = await createClient();
    const { data, error } = await supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false });

    const allLeads = data || [];
    const userRole = user.role || 'user';
    const isCeo = userRole === 'ceo';

    if (error) {
        console.error('Error fetching leads:', error);
    }

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
                    <p className="text-sm text-gray-500 mt-1">Manage dealer leads and track their interest</p>
                </div>
                <Link href="/leads/new">
                    <Button>
                        <Plus className="w-4 h-4 mr-2" />
                        New Lead
                    </Button>
                </Link>
            </div>

            {/* CEO-only: AI Dialer multi-select + assign controls */}
            {isCeo && <AIDialerControls leads={allLeads.map(l => ({ id: l.id, ai_managed: l.ai_managed, manual_takeover: l.manual_takeover, intent_score: l.intent_score }))} userRole={userRole} />}

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Business / Source</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Owner Detail</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Location</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Interest</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                {isCeo && <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">AI Status</th>}
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Call</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {allLeads.map((lead) => (
                                <tr key={lead.id} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="text-sm font-medium text-gray-900">{lead.business_name || 'N/A'}</div>
                                        <div className="text-xs text-gray-500 capitalize">{lead.lead_source?.replace('_', ' ')}</div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="text-sm text-gray-900">{lead.owner_name}</div>
                                        <div className="text-xs text-gray-500">{lead.owner_contact}</div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        {lead.city}, {lead.state}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-2 py-0.5 inline-flex text-xs leading-5 font-semibold rounded-full
                                            ${lead.interest_level === 'hot' ? 'bg-red-100 text-red-800' :
                                                lead.interest_level === 'warm' ? 'bg-orange-100 text-orange-800' :
                                                    'bg-blue-100 text-blue-800'}`}>
                                            {lead.interest_level?.toUpperCase()}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-2 py-0.5 inline-flex text-xs leading-5 font-semibold rounded-full
                                            ${lead.lead_status === 'qualified' ? 'bg-green-100 text-green-800' :
                                                'bg-gray-100 text-gray-800'}`}>
                                            {lead.lead_status?.toUpperCase()}
                                        </span>
                                    </td>
                                    {isCeo && (
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <AIStatusBadges lead={{ id: lead.id, ai_managed: lead.ai_managed, manual_takeover: lead.manual_takeover, intent_score: lead.intent_score }} />
                                        </td>
                                    )}
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <CallButton leadId={lead.id} />
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                                        <Link href={`/leads/${lead.id}/edit`}>
                                            <Button variant="ghost" size="sm" className="text-indigo-600 hover:text-indigo-900">
                                                Edit
                                            </Button>
                                        </Link>
                                        <Link href={`/leads/${lead.id}`}>
                                            <Button variant="ghost" size="sm" className="text-brand-600 hover:text-brand-900">
                                                View
                                            </Button>
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {allLeads.length === 0 && (
                    <div className="p-12 text-center text-gray-500">
                        <p>No leads found.</p>
                        <p className="text-sm mt-1">Create a new lead to get started.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
