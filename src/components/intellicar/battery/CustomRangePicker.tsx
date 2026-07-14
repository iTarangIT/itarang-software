'use client';

import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Custom date range (YYYY-MM-DD). Both ends are required before it fires — a
 * half-filled range would silently query a window the user didn't ask for.
 */
export function CustomRangePicker({
    value,
    onChange,
}: {
    value: { from: string; to: string } | null;
    onChange: (v: { from: string; to: string } | null) => void;
}) {
    const [open, setOpen] = useState(false);
    const [from, setFrom] = useState(value?.from ?? '');
    const [to, setTo] = useState(value?.to ?? '');
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const today = new Date().toISOString().slice(0, 10);
    const invalid = !!from && !!to && from > to;

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'inline-flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg bg-white transition-colors',
                    value ? 'border-brand-300 text-brand-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                )}
            >
                <Calendar className="w-4 h-4 text-gray-400" />
                {value ? `${value.from} → ${value.to}` : 'Custom range'}
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute z-20 mt-2 right-0 w-64 bg-white border border-gray-100 rounded-xl shadow-lg p-3 space-y-2">
                    <label className="block">
                        <span className="text-xs font-medium text-gray-500">From</span>
                        <input
                            type="date"
                            value={from}
                            max={today}
                            onChange={(e) => setFrom(e.target.value)}
                            className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:border-brand-400"
                        />
                    </label>
                    <label className="block">
                        <span className="text-xs font-medium text-gray-500">To</span>
                        <input
                            type="date"
                            value={to}
                            max={today}
                            onChange={(e) => setTo(e.target.value)}
                            className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:border-brand-400"
                        />
                    </label>
                    {invalid && <p className="text-xs text-red-600">From must not be after To.</p>}
                    <div className="flex items-center justify-between pt-1">
                        <button
                            type="button"
                            onClick={() => { onChange(null); setFrom(''); setTo(''); setOpen(false); }}
                            className="text-xs font-medium text-gray-500 hover:underline"
                        >
                            Clear
                        </button>
                        <button
                            type="button"
                            disabled={!from || !to || invalid}
                            onClick={() => { onChange({ from, to }); setOpen(false); }}
                            className="px-3 py-1 rounded-md text-xs font-medium bg-brand-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Apply
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
