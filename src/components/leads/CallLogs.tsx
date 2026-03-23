'use client';

import { useState } from 'react';
import { Phone, ChevronDown, ChevronUp, FileText, Clock } from 'lucide-react';

interface CallLog {
    id: string;
    call_id: string;
    agent_id: string | null;
    phone_number: string | null;
    transcript: string | null;
    summary: string | null;
    recording_url: string | null;
    call_duration: number | null;
    status: string | null;
    created_at: Date;
}

export default function CallLogs({ logs }: { logs: CallLog[] }) {
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const formatDateTime = (date: Date) => {
        return new Intl.DateTimeFormat('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        }).format(date);
    };

    const parseTranscript = (transcript: string | null) => {
        if (!transcript) return [];
        // Assuming transcript is a string with "Assistant: ..." or "User: ..."
        // Adjust split pattern based on actual Bolna transcript format
        const lines = transcript.split('\n');
        return lines.map(line => {
            const match = line.match(/^(Assistant|User|AI|Human):\s*(.*)/i);
            if (match) {
                return {
                    role: match[1].toLowerCase() as 'assistant' | 'user',
                    text: match[2]
                };
            }
            return {
                role: 'unknown' as const,
                text: line
            };
        });
    };

    if (logs.length === 0) {
        return (
            <div className="mt-8 border-t pt-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <span className="bg-blue-100 text-blue-600 p-1 rounded mr-2">
                        <Phone size={18} />
                    </span>
                    AI Call Logs
                </h3>
                <div className="bg-gray-50 rounded-xl border border-dashed border-gray-300 p-8 text-center text-gray-500">
                    <p className="text-sm italic">No Bolna AI calls recorded for this lead yet.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mt-8 border-t pt-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <span className="bg-blue-100 text-blue-600 p-1 rounded mr-2">
                    <Phone size={18} />
                </span>
                AI Call Logs
            </h3>

            <div className="space-y-3">
                {logs.map((log) => (
                    <div key={log.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
                        <div
                            className="p-4 flex justify-between items-center cursor-pointer hover:bg-gray-50 transition-colors"
                            onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                        >
                            <div className="flex items-center gap-4">
                                <div className={`w-3 h-3 rounded-full ${log.status === 'completed' || log.status === 'success' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' :
                                    log.status === 'failed' ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]' :
                                        'bg-blue-500 animate-pulse'
                                    }`} />
                                <div>
                                    <div className="flex items-center gap-2">
                                        <p className="font-semibold text-sm text-gray-900 capitalize">
                                            {log.status || 'Initiated'}
                                        </p>
                                    </div>
                                    <p className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5 font-medium">
                                        <Clock size={10} />
                                        {formatDateTime(new Date(log.created_at))}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <div className="hidden md:block text-right">
                                    <p className="text-[10px] text-gray-400 font-mono">ID: {log.call_id.slice(-8)}</p>
                                </div>
                                {expandedId === log.id ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
                            </div>
                        </div>

                        {expandedId === log.id && (
                            <div className="px-4 pb-4 bg-gray-50 border-t border-gray-100">
                                {log.summary && (
                                    <div className="mt-4 mb-4">
                                        <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                            <FileText size={14} className="text-orange-500" />
                                            Call Summary
                                        </div>
                                        <div className="text-sm p-3 bg-white rounded-lg border border-gray-100 shadow-sm text-gray-700 italic">
                                            {log.summary}
                                        </div>
                                    </div>
                                )}

                                <div className="py-3 flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider">
                                    <FileText size={14} className="text-blue-500" />
                                    Conversation Transcript
                                </div>

                                <div className="space-y-3 bg-white border border-gray-200 p-4 rounded-lg max-h-[400px] overflow-y-auto shadow-inner">
                                    {log.transcript ? (
                                        parseTranscript(log.transcript).map((msg, i) => (
                                            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                                <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm shadow-sm ${msg.role === 'user'
                                                    ? 'bg-brand-600 text-white rounded-br-none'
                                                    : 'bg-gray-100 text-gray-800 rounded-bl-none'}`}
                                                >
                                                    {msg.text}
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="flex flex-col items-center justify-center py-6 text-gray-400 italic text-xs">
                                            <p>No transcript available.</p>
                                        </div>
                                    )}
                                </div>

                                <div className="mt-4 flex flex-wrap justify-between items-center gap-2 px-1">
                                    <div className="flex items-center gap-3">
                                        <span className="text-[10px] text-gray-400 font-medium">Bolna ID: {log.call_id}</span>
                                        {log.recording_url && (
                                            <a
                                                href={log.recording_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[10px] text-brand-600 hover:text-brand-800 font-bold flex items-center gap-1 bg-brand-50 px-2 py-0.5 rounded border border-brand-100 transition-colors"
                                            >
                                                Listen to Recording
                                            </a>
                                        )}
                                    </div>
                                    {log.call_duration && (
                                        <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-[10px] font-bold border border-gray-200">
                                            Duration: {Math.floor(log.call_duration / 60)}m {log.call_duration % 60}s
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
