import React, { useState, useEffect } from 'react';
import { PlayCircle, Search, PhoneOutgoing, Mic, Activity, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BolnaCall } from '../types';

export const Calls: React.FC = () => {
    const [calls, setCalls] = useState<BolnaCall[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        fetchCalls();
    }, []);

    const fetchCalls = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('bolna_calls')
                .select('*')
                .order('initiated_at', { ascending: false });

            if (error) throw error;
            setCalls(data || []);
        } catch (error) {
            console.error('Error fetching calls:', error);
        } finally {
            setLoading(false);
        }
    };

    const filtered = calls.filter(c =>
        c.lead_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        c.phone_number.includes(searchTerm)
    );

    const getSentimentStyle = (score: number) => {
        if (score > 0.5) return 'text-green-600 bg-green-50 border-green-100';
        if (score < -0.3) return 'text-red-600 bg-red-50 border-red-100';
        return 'text-gray-600 bg-gray-50 border-gray-100';
    };

    const formatDuration = (seconds: number) => {
        const min = Math.floor(seconds / 60);
        const sec = seconds % 60;
        return `${min}:${sec.toString().padStart(2, '0')}`;
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Bolna.ai Call History</h1>
                    <p className="text-gray-500 text-sm mt-1">Review AI agent conversations, transcripts, and sentiment analysis.</p>
                </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-gray-100 flex items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search by name or phone..."
                            className="w-full pl-10 pr-4 py-2 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-primary-100 focus:bg-white transition-all"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>

                <div className="overflow-x-auto">
                    {loading ? (
                        <div className="flex items-center justify-center p-12 text-gray-500">
                            <Loader2 className="w-8 h-8 animate-spin mr-2" />
                            Loading call history...
                        </div>
                    ) : (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50/50 text-gray-500 text-xs font-semibold uppercase tracking-wider">
                                    <th className="px-6 py-4">Lead</th>
                                    <th className="px-6 py-4">Date & Time</th>
                                    <th className="px-6 py-4">Duration</th>
                                    <th className="px-6 py-4">Phase Reached</th>
                                    <th className="px-6 py-4">Sentiment</th>
                                    <th className="px-6 py-4">Cost</th>
                                    <th className="px-6 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="px-6 py-8 text-center text-gray-400 text-sm">No call logs found.</td>
                                    </tr>
                                ) : filtered.map((call) => (
                                    <tr key={call.id} className="hover:bg-gray-50/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
                                                    <PhoneOutgoing className="w-4 h-4" />
                                                </div>
                                                <div>
                                                    <div className="font-medium text-gray-900">{call.lead_name}</div>
                                                    <div className="text-xs text-gray-400">{call.phone_number}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-600">{call.initiated_at}</td>
                                        <td className="px-6 py-4 text-sm text-gray-600 font-mono">{formatDuration(call.duration_seconds)}</td>
                                        <td className="px-6 py-4">
                                            <span className="inline-flex items-center px-2 py-1 rounded-md bg-gray-100 text-xs font-medium text-gray-700">
                                                {call.current_phase}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={`px-2 py-1 rounded-lg border text-xs font-medium flex items-center gap-1 w-fit ${getSentimentStyle(call.sentiment_score)}`}>
                                                <Activity className="w-3 h-3" />
                                                {call.sentiment_score > 0 ? 'Positive' : call.sentiment_score < 0 ? 'Negative' : 'Neutral'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-600">₹{call.cost_rupees.toFixed(2)}</td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                <button className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500" title="Play Recording">
                                                    <PlayCircle className="w-4 h-4" />
                                                </button>
                                                <button className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500" title="View Transcript">
                                                    <Mic className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
};