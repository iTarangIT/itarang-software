'use client';

import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Interactive month picker: a button that opens a popover with a year stepper
 * and a 12-month grid. `value`/`max` are 'YYYY-MM'; future months are disabled.
 * Empty value shows "Pick month". Choosing a month calls onChange; a footer
 * "Clear" resets to the rolling window.
 */
export function MonthPicker({
    value,
    onChange,
    max,
}: {
    value: string;
    onChange: (v: string) => void;
    max: string;
}) {
    const [open, setOpen] = useState(false);
    const [viewYear, setViewYear] = useState(() => Number((value || max).slice(0, 4)));
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const maxYear = Number(max.slice(0, 4));
    const maxMonth = Number(max.slice(5, 7));
    const selYear = value ? Number(value.slice(0, 4)) : null;
    const selMonth = value ? Number(value.slice(5, 7)) : null;
    const label = value
        ? new Date(`${value}-01T00:00:00`).toLocaleString('default', { month: 'short', year: 'numeric' })
        : 'Pick month';

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
                {label}
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute z-20 mt-2 right-0 w-64 bg-white border border-gray-100 rounded-xl shadow-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                        <button type="button" onClick={() => setViewYear((y) => y - 1)} className="p-1 rounded-md hover:bg-gray-100 text-gray-600">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-sm font-semibold text-gray-900">{viewYear}</span>
                        <button
                            type="button"
                            disabled={viewYear >= maxYear}
                            onClick={() => setViewYear((y) => y + 1)}
                            className="p-1 rounded-md hover:bg-gray-100 text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                        {MONTH_NAMES.map((name, i) => {
                            const m = i + 1;
                            const disabled = viewYear > maxYear || (viewYear === maxYear && m > maxMonth);
                            const active = selYear === viewYear && selMonth === m;
                            return (
                                <button
                                    key={m}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => { onChange(`${viewYear}-${String(m).padStart(2, '0')}`); setOpen(false); }}
                                    className={cn(
                                        'px-2 py-1.5 text-sm rounded-md transition-colors',
                                        active ? 'bg-brand-600 text-white' : disabled ? 'text-gray-300 cursor-not-allowed' : 'text-gray-700 hover:bg-gray-100',
                                    )}
                                >
                                    {name}
                                </button>
                            );
                        })}
                    </div>
                    {value && (
                        <div className="mt-2 pt-2 border-t border-gray-100 text-right">
                            <button type="button" onClick={() => { onChange(''); setOpen(false); }} className="text-xs font-medium text-brand-600 hover:underline">
                                Clear
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
