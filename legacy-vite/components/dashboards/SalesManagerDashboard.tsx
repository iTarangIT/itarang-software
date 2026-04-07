import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import { Phone, Pause, Play, Edit2, Loader2, MessageSquare, TrendingUp } from 'lucide-react';

interface AssignedLead {
    id: string;
    name: string;
    phone: string;
    status: string;
    score: number;
    total_bolna_calls: number;
    bolna_qualification_status: string;
    highest_phase_reached?: string;
}

interface ActiveCall {
    id: string;
    lead_name: string;
    status: string;
    current_phase: string;
    duration_seconds: number;
}

export const SalesManagerDashboard: React.FC = () => {
    const { user } = useAuth();
    const [leads, setLeads] = useState<AssignedLead[]>([]);
    const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedLead, setSelectedLead] = useState<string | null>(null);
    const [modifyingRequirement, setModifyingRequirement] = useState(false);
    const [requirement, setRequirement] = useState('');

    useEffect(() => {
        if (user) {
            fetchAssignedLeads();
            fetchActiveCalls();
        }
    }, [user]);

    async function fetchAssignedLeads() {
        try {
            setLoading(true);
            const { data } = await supabase
                .from('leads')
                .select('*')
                .eq('assigned_to', user?.id)
                .order('created_at', { ascending: false });

            setLeads(data || []);
        } catch (error) {
            console.error('Error fetching assigned leads:', error);
        } finally {
            setLoading(false);
        }
    }

    async function fetchActiveCalls() {
        try {
            const { data } = await supabase
                .from('bolna_calls')
                .select('*')
                .in('status', ['in_progress', 'paused'])
                .order('initiated_at', { ascending: false });

            setActiveCalls(data || []);
        } catch (error) {
            console.error('Error fetching active calls:', error);
        }
    }

    async function pauseCall(callId: string) {
        try {
            await supabase
                .from('bolna_calls')
                .update({ status: 'paused' })
                .eq('id', callId);

            await fetchActiveCalls();
        } catch (error) {
            console.error('Error pausing call:', error);
        }
    }

    async function resumeCall(callId: string) {
        try {
            await supabase
                .from('bolna_calls')
                .update({ status: 'in_progress' })
                .eq('id', callId);

            await fetchActiveCalls();
        } catch (error) {
            console.error('Error resuming call:', error);
        }
    }

    async function initiateCall(leadId: string) {
        try {
            const lead = leads.find(l => l.id === leadId);
            if (!lead) return;

            // In production, this would call the Bolna.ai API
            const newCallId = `CALL-${Date.now()}`;

            await supabase.from('bolna_calls').insert({
                id: newCallId,
                lead_name: lead.name,
                phone_number: lead.phone,
                status: 'initiated',
                current_phase: 'Introduction',
                initiated_at: new Date().toISOString(),
                duration_seconds: 0,
                cost_rupees: 0,
                sentiment_score: 0,
            });

            await fetchActiveCalls();
            await fetchAssignedLeads();
        } catch (error) {
            console.error('Error initiating call:', error);
        }
    }

    async function updateRequirement(leadId: string) {
        try {
            // In production, this would update the lead's requirement notes
            // and trigger the AI to resume from the appropriate phase

            await supabase
                .from('leads')
                .update({
                    // Add a notes field or requirement field in production
                    status: 'AI_In_Progress'
                })
                .eq('id', leadId);

            setModifyingRequirement(false);
            setRequirement('');
            setSelectedLead(null);
            await fetchAssignedLeads();
        } catch (error) {
            console.error('Error updating requirement:', error);
        }
    }

    const stats = {
        totalAssigned: leads.length,
        inProgress: leads.filter(l => l.bolna_qualification_status === 'in_progress').length,
        qualified: leads.filter(l => l.status === 'Qualified').length,
        activeCalls: activeCalls.length,
    };

    if (loading) {
        return (
            <div className="space-y-6 animate-fade-in">
                <div className="space-y-2">
                    <div className="h-8 w-64 bg-slate-200 rounded-lg animate-pulse" />
                    <div className="h-4 w-48 bg-slate-100 rounded animate-pulse" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="h-32 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
                    ))}
                </div>
                <div className="h-48 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-fade-in">
            <div>
                <h1 className="text-2xl font-bold text-gray-900">Sales Manager Dashboard</h1>
                <p className="text-gray-500 text-sm mt-1">Manage your assigned leads and AI call interactions</p>
            </div>

            {/* KPI Cards - Neutral Palette (SOP #2.2) */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {[
                    { label: 'Assigned Leads', value: stats.totalAssigned, icon: MessageSquare, sub: 'Total allocated' },
                    { label: 'In Progress', value: stats.inProgress, icon: Phone, sub: 'Qualification active' },
                    { label: 'Qualified', value: stats.qualified, icon: TrendingUp, sub: 'Ready for dealer' },
                    { label: 'Active Calls', value: stats.activeCalls, icon: Play, sub: 'Live monitoring' },
                ].map((kpi, i) => (
                    <div key={i} className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-all group">
                        <div className="flex items-center justify-between mb-4">
                            <div className="p-2 bg-slate-50 rounded-lg text-slate-400 group-hover:text-primary-600 transition-colors">
                                <kpi.icon className="w-5 h-5" />
                            </div>
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">MTD</span>
                        </div>
                        <p className="text-3xl font-black text-slate-900">{kpi.value}</p>
                        <p className="text-xs text-slate-500 mt-1">{kpi.sub}</p>
                    </div>
                ))}
            </div>

            {/* Live AI Call Monitor - High Trust Monitor (v2.1) */}
            {activeCalls.length > 0 && (
                <div className="bg-slate-900 text-white rounded-2xl border border-slate-800 shadow-2xl overflow-hidden animate-slide-up">
                    <div className="p-4 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-2 h-2 bg-red-500 rounded-full animate-blink"></div>
                            <h2 className="text-sm font-bold uppercase tracking-wider">Live AI Monitor</h2>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono">ENCRYPTED_FEED_04</div>
                    </div>
                    <div className="divide-y divide-slate-800">
                        {activeCalls.map(call => (
                            <div key={call.id} className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-8">
                                {/* Call Info */}
                                <div className="space-y-4">
                                    <div>
                                        <p className="text-xs text-slate-400 uppercase font-bold tracking-widest mb-1">Lead</p>
                                        <h3 className="text-xl font-bold">{call.lead_name}</h3>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <div className="px-3 py-1 bg-green-500/10 text-green-400 rounded-full text-[10px] font-bold border border-green-500/20">
                                            LIVE
                                        </div>
                                        <p className="text-xs text-slate-400 font-mono">
                                            {Math.floor(call.duration_seconds / 60)}m {call.duration_seconds % 60}s
                                        </p>
                                    </div>
                                    <div className="flex gap-2">
                                        <button onClick={() => pauseCall(call.id)} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-bold transition-all">
                                            PAUSE_AI
                                        </button>
                                        <button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-bold transition-all">
                                            WHISPER
                                        </button>
                                    </div>
                                </div>

                                {/* AI State & Progress */}
                                <div className="space-y-4">
                                    <div>
                                        <p className="text-xs text-slate-400 uppercase font-bold tracking-widest mb-2">Phase Progress</p>
                                        <div className="flex items-center justify-between text-[10px] text-slate-300 mb-1">
                                            <span>{call.current_phase}</span>
                                            <span>75%</span>
                                        </div>
                                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                            <div className="bg-primary-500 h-full w-3/4 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.5)]"></div>
                                        </div>
                                    </div>
                                    <div className="bg-slate-800/50 p-3 rounded-xl border border-slate-800">
                                        <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">AI Intent Detection</p>
                                        <div className="flex items-center gap-2">
                                            <div className="text-xs text-green-400 font-medium">B2B Commercial Intent</div>
                                            <span className="text-[10px] text-slate-500">(0.98 confidence)</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Live Transcript Mock */}
                                <div className="bg-black/40 rounded-xl p-4 font-mono text-[11px] h-32 overflow-y-auto space-y-2 border border-slate-800">
                                    <p className="text-slate-500">[02:14] AI: Understanding... checking stock for 12 units.</p>
                                    <p className="text-primary-400">LEAD: "Can we get delivery by Friday?"</p>
                                    <div className="flex items-center gap-2">
                                        <span className="w-1 h-3 bg-primary-500 animate-pulse"></span>
                                        <p className="text-slate-400 italic">AI is thinking...</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Assigned Leads Table */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                    <h2 className="text-lg font-bold text-gray-900">My Assigned Leads</h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-gray-50 border-b border-gray-100">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Lead</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Phone</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Status</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">AI Progress</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Calls</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {leads.map(lead => (
                                <tr key={lead.id} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="font-medium text-gray-900">{lead.name}</div>
                                        <div className="text-xs text-gray-500">{lead.id}</div>
                                    </td>
                                    <td className="px-6 py-4 text-sm text-gray-600">{lead.phone}</td>
                                    <td className="px-6 py-4">
                                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${lead.status === 'Qualified' ? 'bg-green-100 text-green-700' :
                                            lead.status === 'AI_In_Progress' ? 'bg-blue-100 text-blue-700' :
                                                'bg-gray-100 text-gray-700'
                                            }`}>
                                            {lead.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="text-sm text-gray-600">
                                            {lead.highest_phase_reached || 'Not started'}
                                        </div>
                                        <div className="text-xs text-gray-500 mt-1">
                                            {lead.bolna_qualification_status}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-sm text-gray-600">{lead.total_bolna_calls}</td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => initiateCall(lead.id)}
                                                className="p-2 bg-primary-100 text-primary-700 rounded-lg hover:bg-primary-200 transition-colors"
                                                title="Start AI Call"
                                            >
                                                <Phone className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setSelectedLead(lead.id);
                                                    setModifyingRequirement(true);
                                                }}
                                                className="p-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                                                title="Modify Requirements"
                                            >
                                                <Edit2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Modify Requirement Modal */}
            {modifyingRequirement && selectedLead && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
                    <div className="bg-white rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl">
                        <h3 className="text-xl font-bold text-gray-900 mb-4">Modify Lead Requirements</h3>
                        <p className="text-sm text-gray-600 mb-4">
                            Update the requirements so the AI can pick up qualification from the appropriate point.
                        </p>
                        <textarea
                            value={requirement}
                            onChange={(e) => setRequirement(e.target.value)}
                            placeholder="Enter updated requirements..."
                            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-500 outline-none resize-none"
                            rows={4}
                        />
                        <div className="flex gap-3 mt-6">
                            <button
                                onClick={() => updateRequirement(selectedLead)}
                                className="flex-1 px-6 py-3 bg-primary-600 text-white rounded-xl font-medium hover:bg-primary-700 transition-colors"
                            >
                                Update & Resume AI
                            </button>
                            <button
                                onClick={() => {
                                    setModifyingRequirement(false);
                                    setSelectedLead(null);
                                    setRequirement('');
                                }}
                                className="px-6 py-3 bg-gray-100 text-gray-700 rounded-xl font-medium hover:bg-gray-200 transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
