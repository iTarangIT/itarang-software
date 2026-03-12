import { db } from '@/lib/db';
import { bolnaCalls, leads } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { Phone, CheckCircle2, Clock, XCircle } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function AICallsPage() {
    await requireAuth();

    const allCalls = await db.select({
        id: bolnaCalls.id,
        bolna_call_id: bolnaCalls.bolna_call_id,
        lead_id: bolnaCalls.lead_id,
        status: bolnaCalls.status,
        current_phase: bolnaCalls.current_phase,
        started_at: bolnaCalls.started_at,
        ended_at: bolnaCalls.ended_at,
        created_at: bolnaCalls.created_at,
    })
        .from(bolnaCalls)
        .orderBy(desc(bolnaCalls.created_at))
        .limit(100);

    const completedCount = allCalls.filter(c => c.status === 'completed').length;
    const activeCount = allCalls.filter(c => ['initiated', 'in_progress'].includes(c.status)).length;

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">AI Call History</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Bolna AI Dialer call logs and transcripts</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Total Calls</p>
                    <p className="text-3xl font-black text-gray-900">{allCalls.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Completed</p>
                    <p className="text-3xl font-black text-green-600">{completedCount}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Active</p>
                    <p className="text-3xl font-black text-blue-600">{activeCount}</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Call ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lead</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Phase</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Started</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {allCalls.map((call) => {
                            const duration = call.started_at && call.ended_at
                                ? Math.round((new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()) / 1000)
                                : null;
                            return (
                                <tr key={call.id} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900">{call.bolna_call_id.slice(0, 12)}...</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium">{call.lead_id || '—'}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{call.current_phase || '—'}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                                        {call.started_at ? new Date(call.started_at).toLocaleString() : '—'}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                                        {duration !== null ? `${Math.floor(duration / 60)}m ${duration % 60}s` : '—'}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-3 py-1 rounded-full text-xs font-bold ${call.status === 'completed' ? 'bg-green-100 text-green-700' : call.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                                            {call.status.toUpperCase()}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {allCalls.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <Phone className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No AI calls found.</p>
                        <p className="text-sm">AI dialer call history will appear here.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
