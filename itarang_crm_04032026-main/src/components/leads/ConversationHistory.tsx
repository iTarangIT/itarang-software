
'use client';

import React, { useState } from 'react';
import { Search, Phone, Clock, Play, FileText, ChevronDown, ChevronUp } from 'lucide-react';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    message: string;
    timestamp: string;
}

interface CallRecord {
    id: string;
    status: string;
    duration_seconds: number | null;
    recording_url: string | null;
    summary: string | null;
    created_at: string;
    messages: Message[];
}

interface ConversationHistoryProps {
    records: CallRecord[];
}

export default function ConversationHistory({ records }: ConversationHistoryProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [expandedRecords, setExpandedRecords] = useState<string[]>(records.length > 0 ? [records[0].id] : []);

    const toggleRecord = (id: string) => {
        setExpandedRecords(prev =>
            prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
        );
    };

    const filteredRecords = records.filter(record =>
        record.summary?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        record.messages.some(m => m.message.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    return (
        <div className="mt-8 border-t pt-6">
            <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                    <span className="bg-brand-100 text-brand-600 p-1 rounded mr-2">
                        <Phone size={18} />
                    </span>
                    AI Conversation History
                </h3>

                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                    <input
                        type="text"
                        placeholder="Search conversations..."
                        className="pl-9 pr-4 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
            </div>

            <div className="space-y-4">
                {filteredRecords.length > 0 ? (
                    filteredRecords.map((record) => (
                        <div key={record.id} className="bg-slate-50 rounded-xl border border-gray-200 overflow-hidden">
                            <button
                                onClick={() => toggleRecord(record.id)}
                                className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-100 transition-colors"
                            >
                                <div className="flex items-center gap-4">
                                    <div className={`w-2 h-2 rounded-full ${record.status === 'completed' ? 'bg-green-500' : 'bg-amber-500'}`} />
                                    <div className="text-left">
                                        <p className="text-sm font-semibold text-gray-900">
                                            Call {record.id.split('-').pop()} • {new Date(record.created_at).toLocaleDateString()}
                                        </p>
                                        <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
                                            <span className="flex items-center gap-1">
                                                <Clock size={12} /> {record.duration_seconds || 0}s
                                            </span>
                                            {record.recording_url && (
                                                <a
                                                    href={record.recording_url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="flex items-center gap-1 text-brand-600 hover:underline"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <Play size={12} /> Recording
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                {expandedRecords.includes(record.id) ? <ChevronUp size={20} className="text-gray-400" /> : <ChevronDown size={20} className="text-gray-400" />}
                            </button>

                            {expandedRecords.includes(record.id) && (
                                <div className="px-5 pb-5 border-t border-gray-100 bg-white">
                                    {record.summary && (
                                        <div className="mt-4 p-3 bg-brand-5 rounded-lg border border-brand-100 mb-6">
                                            <h4 className="text-xs font-bold text-brand-700 uppercase mb-1 flex items-center gap-1">
                                                <FileText size={12} /> AI Summary
                                            </h4>
                                            <p className="text-sm text-gray-700">{record.summary}</p>
                                        </div>
                                    )}

                                    <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                                        {record.messages.length > 0 ? (
                                            record.messages.map((m) => (
                                                <div key={m.id} className={`flex ${m.role === 'assistant' ? 'justify-start' : 'justify-end'}`}>
                                                    <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${m.role === 'assistant'
                                                            ? 'bg-slate-100 text-gray-800 rounded-tl-none'
                                                            : 'bg-brand-600 text-white rounded-tr-none'
                                                        }`}>
                                                        <p>{m.message}</p>
                                                        <p className={`text-[10px] mt-1 ${m.role === 'assistant' ? 'text-gray-400' : 'text-brand-200'}`}>
                                                            {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </p>
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-center text-gray-400 py-8 italic text-sm">No transcript available for this call.</p>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))
                ) : (
                    <div className="text-center py-12 px-4 border-2 border-dashed border-gray-200 rounded-xl">
                        <Phone size={48} className="mx-auto text-gray-200 mb-3" />
                        <p className="text-gray-500 font-medium">No conversation records found</p>
                        <p className="text-gray-400 text-sm">Try refreshing or check if any calls were made.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
