'use client';

import { useState } from 'react';
import { Brain, Check, Loader2, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Lead {
    id: string;
    ai_managed?: boolean;
    manual_takeover?: boolean;
    intent_score?: number;
}

interface AIDialerControlsProps {
    leads: Lead[];
    userRole: string;
}

type Provider = 'bolna' | 'elevenlabs';

export function AIDialerControls({ leads, userRole }: AIDialerControlsProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [assigning, setAssigning] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);

    if (userRole !== 'ceo') return null;

    const toggleSelect = (id: string) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelected(next);
    };

    const toggleAll = () => {
        if (selected.size === leads.length) {
            setSelected(new Set());
        } else {
            setSelected(new Set(leads.map(l => l.id)));
        }
    };

    const openPicker = () => {
        if (selected.size === 0 || assigning) return;
        setResult(null);
        setPickerOpen(true);
    };

    const assignToAI = async (provider: Provider) => {
        setPickerOpen(false);
        setAssigning(true);
        try {
            const res = await fetch('/api/ceo/ai-dialer/assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadIds: Array.from(selected), provider }),
            });
            const data = await res.json();
            if (data.success) {
                setResult(`Assigned ${data.assigned} leads to ${provider === 'elevenlabs' ? 'ElevenLabs' : 'Bolna'}. ${data.scored} scored.`);
                setSelected(new Set());
            } else {
                setResult(`Error: ${data.error?.message || 'Unknown'}`);
            }
        } catch {
            setResult('Failed to assign leads');
        } finally {
            setAssigning(false);
        }
    };

    return (
        <div className="mb-4 space-y-3">
            <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl border border-blue-100">
                <button
                    onClick={toggleAll}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-white rounded-lg border border-blue-200 hover:bg-blue-50"
                >
                    <Check className="w-3 h-3" />
                    {selected.size === leads.length ? 'Deselect All' : 'Select All'}
                </button>
                <span className="text-xs text-blue-600">{selected.size} selected</span>
                <button
                    onClick={openPicker}
                    disabled={selected.size === 0 || assigning}
                    className="inline-flex items-center gap-1 px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                    {assigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
                    Assign to AI Dialer
                </button>
                {result && <span className="text-xs text-blue-700">{result}</span>}
            </div>

            <div className="hidden">
                {leads.map(l => (
                    <input key={l.id} type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)} />
                ))}
            </div>

            <ProviderPickerModal
                isOpen={pickerOpen}
                onClose={() => setPickerOpen(false)}
                onPick={assignToAI}
                count={selected.size}
            />
        </div>
    );
}

function ProviderPickerModal({
    isOpen,
    onClose,
    onPick,
    count,
}: {
    isOpen: boolean;
    onClose: () => void;
    onPick: (p: Provider) => void;
    count: number;
}) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
                <div className="flex items-center justify-between px-6 py-4 border-b">
                    <h3 className="text-lg font-semibold text-gray-900">Choose AI Voice Agent</h3>
                    <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-500">
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-6 space-y-3">
                    <p className="text-sm text-gray-600">
                        Calling <span className="font-semibold">{count}</span> selected lead{count === 1 ? '' : 's'}. Pick a voice agent to handle the dialer session.
                    </p>
                    <button
                        onClick={() => onPick('bolna')}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left rounded-xl border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-all"
                    >
                        <div className="w-10 h-10 flex items-center justify-center rounded-lg bg-blue-100 text-blue-600">
                            <Brain className="w-5 h-5" />
                        </div>
                        <div>
                            <div className="font-semibold text-gray-900">Bolna</div>
                            <div className="text-xs text-gray-500">Existing voice agent — production-tested</div>
                        </div>
                    </button>
                    <button
                        onClick={() => onPick('elevenlabs')}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left rounded-xl border border-gray-200 hover:border-violet-400 hover:bg-violet-50 transition-all"
                    >
                        <div className="w-10 h-10 flex items-center justify-center rounded-lg bg-violet-100 text-violet-600">
                            <Sparkles className="w-5 h-5" />
                        </div>
                        <div>
                            <div className="font-semibold text-gray-900">ElevenLabs</div>
                            <div className="text-xs text-gray-500">New voice agent — A/B test alongside Bolna</div>
                        </div>
                    </button>
                </div>
            </div>
        </div>
    );
}

export function LeadSelectCheckbox({ leadId, selected, onToggle }: { leadId: string; selected: boolean; onToggle: (id: string) => void }) {
    return (
        <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(leadId)}
            className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
        />
    );
}

export function AIStatusBadges({ lead }: { lead: Lead }) {
    return (
        <div className="flex items-center gap-1">
            {lead.ai_managed && !lead.manual_takeover && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700">
                    AI
                </span>
            )}
            {lead.manual_takeover && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
                    Manual
                </span>
            )}
            {lead.intent_score != null && lead.intent_score > 0 && (
                <span className={cn(
                    'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold',
                    lead.intent_score >= 70 ? 'bg-green-100 text-green-700' :
                    lead.intent_score >= 40 ? 'bg-amber-100 text-amber-700' :
                    'bg-red-100 text-red-700'
                )}>
                    {lead.intent_score}
                </span>
            )}
        </div>
    );
}
