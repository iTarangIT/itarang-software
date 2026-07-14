'use client';

import { useState, useRef, useEffect } from 'react';
import { BatteryCharging, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Searchable battery picker: a button that opens a popover with a search box and a
 * scrollable, client-side-filtered list of the whole fleet (matches on vehicle no /
 * device_id and customer name). Choosing one calls onChange; outside-click closes.
 */
export function BatteryPicker({
    value,
    onChange,
    options,
}: {
    value: string;
    onChange: (v: string) => void;
    options: Array<Record<string, unknown>>;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const ref = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    useEffect(() => {
        if (open) inputRef.current?.focus();
    }, [open]);

    const items = options
        .map((b) => ({
            id: String(b.device_id || b.vehicle_number || ''),
            name: b.customer_name ? String(b.customer_name) : '',
        }))
        .filter((o) => o.id);

    const needle = q.trim().toLowerCase();
    const filtered = needle
        ? items.filter((o) => o.id.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle))
        : items;

    const selected = items.find((o) => o.id === value);
    const label = selected
        ? `${selected.id}${selected.name ? ` — ${selected.name}` : ''}`
        : 'Select a battery…';

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'inline-flex items-center gap-2 px-3 py-2 text-sm border rounded-lg bg-white transition-colors min-w-[240px] max-w-[320px]',
                    value ? 'border-brand-300 text-brand-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                )}
            >
                <BatteryCharging className="w-4 h-4 text-gray-400 shrink-0" />
                <span className="truncate flex-1 text-left">{label}</span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform shrink-0', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute z-20 mt-2 left-0 w-72 bg-white border border-gray-100 rounded-xl shadow-lg p-2">
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1 border-b border-gray-100">
                        <Search className="w-4 h-4 text-gray-400 shrink-0" />
                        <input
                            ref={inputRef}
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Search vehicle no or customer…"
                            className="w-full text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none"
                        />
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                        {filtered.length === 0 ? (
                            <div className="px-3 py-6 text-center text-sm text-gray-400">No matches</div>
                        ) : (
                            filtered.map((o) => (
                                <button
                                    key={o.id}
                                    type="button"
                                    onClick={() => { onChange(o.id); setOpen(false); setQ(''); }}
                                    className={cn(
                                        'w-full text-left px-3 py-2 text-sm rounded-md transition-colors',
                                        o.id === value ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100',
                                    )}
                                >
                                    <span className="font-medium">{o.id}</span>
                                    {o.name && (
                                        <span className={cn('ml-1', o.id === value ? 'text-brand-100' : 'text-gray-400')}>— {o.name}</span>
                                    )}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
