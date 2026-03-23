'use client';

import { useState } from 'react';
import { Brain, Check, Loader2 } from 'lucide-react';
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

export function AIDialerControls({ leads, userRole }: AIDialerControlsProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [assigning, setAssigning] = useState(false);
    const [result, setResult] = useState<string | null>(null);

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

    const assignToAI = async () => {
        if (selected.size === 0) return;
        setAssigning(true);
        setResult(null);
        try {
            const res = await fetch('/api/ceo/ai-dialer/assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadIds: Array.from(selected) }),
            });
            const data = await res.json();
            if (data.success) {
                setResult(`Assigned ${data.assigned} leads to AI Dialer. ${data.scored} scored.`);
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
            {/* AI Assign bar */}
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
                    onClick={assignToAI}
                    disabled={selected.size === 0 || assigning}
                    className="inline-flex items-center gap-1 px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                    {assigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
                    Assign to AI Dialer
                </button>
                {result && <span className="text-xs text-blue-700">{result}</span>}
            </div>

            {/* Checkbox column injector - renders hidden inputs for the table */}
            <div className="hidden">
                {leads.map(l => (
                    <input key={l.id} type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)} />
                ))}
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
