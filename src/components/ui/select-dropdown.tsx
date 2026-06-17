'use client';

// Custom dropdown (not a native <select>). A native select's option list is
// drawn by the browser/OS as an overlay that can't be clipped to a layout — in
// the mobile preview it spilled past the edges of the phone frame. This renders
// the list in a portal with FIXED positioning, computed from the trigger:
//   • top is clamped below the sticky page header (z-20, ~64px) so the panel
//     never overlaps the navbar, regardless of scroll position / open direction;
//   • height is capped to the available band and the list scrolls internally;
//   • it flips upward only when there isn't room below.
// Reused by SelectField, ProductSelector, and the DatePicker.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';

export type DropdownOption = { value: string; label: string };

// Sticky header is `sticky top-0 z-20` and ~64px tall (see layout/header.tsx).
const NAV_SAFE = 72;   // top bound: header height + a little margin
const EDGE_SAFE = 12;  // bottom/viewport edge margin
const GAP = 8;         // gap between trigger and panel
const MAX_H = 320;
const MIN_H = 140;

export function Dropdown({
    value, onChange, options, placeholder, disabled, error,
    className, triggerClassName, searchThreshold = 8,
}: {
    value: string;
    onChange: (v: string) => void;
    options: DropdownOption[];
    placeholder?: string;
    disabled?: boolean;
    error?: boolean;
    className?: string;
    triggerClassName?: string;
    searchThreshold?: number;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const selected = options.find(o => o.value === value);
    const showSearch = options.length > searchThreshold;
    const filtered = query
        ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
        : options;

    const computePosition = () => {
        const el = triggerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom - EDGE_SAFE;
        const spaceAbove = rect.top - NAV_SAFE - EDGE_SAFE;
        const up = spaceBelow < 220 && spaceAbove > spaceBelow;
        let top: number;
        let maxHeight: number;
        if (up) {
            maxHeight = Math.max(MIN_H, Math.min(spaceAbove, MAX_H));
            top = Math.max(NAV_SAFE, rect.top - GAP - maxHeight);
        } else {
            top = Math.max(NAV_SAFE, rect.bottom + GAP);
            maxHeight = Math.max(MIN_H, Math.min(window.innerHeight - top - EDGE_SAFE, MAX_H));
        }
        // Narrow triggers (e.g. Day/Year) can't show the search box or full
        // option labels at their own width — widen the panel to a usable minimum
        // when needed, then clamp left so it never spills past the viewport edge.
        const minWidth = showSearch ? 224 : 0;
        const width = Math.min(
            Math.max(rect.width, minWidth),
            window.innerWidth - 2 * EDGE_SAFE,
        );
        const maxLeft = window.innerWidth - width - EDGE_SAFE;
        const left = Math.min(Math.max(EDGE_SAFE, rect.left), Math.max(EDGE_SAFE, maxLeft));
        setPos({ top, left, width, maxHeight });
    };

    const toggle = () => {
        if (disabled) return;
        if (!open) computePosition();
        setOpen(o => !o);
    };

    useEffect(() => {
        if (!open) { setQuery(''); return; }
        const onDoc = (e: MouseEvent) => {
            const t = e.target as Node;
            if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        // Close on page scroll/resize so the fixed panel can't drift from its
        // trigger — but ignore scrolling that happens inside the panel's list.
        const onScroll = (e: Event) => {
            if (panelRef.current && panelRef.current.contains(e.target as Node)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }, [open]);

    return (
        <div className={`relative ${className || ''}`}>
            <button
                type="button"
                ref={triggerRef}
                onClick={toggle}
                disabled={disabled}
                className={`w-full h-10 sm:h-11 px-4 pr-10 bg-white border-2 rounded-xl outline-none transition-all text-sm text-left flex items-center ${
                    disabled ? 'bg-gray-50 border-[#F5F5F5] text-gray-400 cursor-not-allowed' :
                    error ? 'border-red-400' :
                    open ? 'border-[#1D4ED8] ring-4 ring-blue-50/50' :
                    'border-[#EBEBEB]'
                } ${selected ? 'text-gray-900' : 'text-gray-400'} ${triggerClassName || ''}`}
            >
                <span className="truncate">{selected ? selected.label : (placeholder || 'Select...')}</span>
            </button>
            <ChevronDown className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none transition-transform ${open ? 'rotate-180' : ''}`} />

            {open && !disabled && pos && createPortal(
                <div
                    ref={panelRef}
                    style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
                    className="z-[100] flex flex-col bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden"
                >
                    {showSearch && (
                        <div className="p-2 border-b border-gray-100 shrink-0">
                            <div className="relative">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                                <input
                                    autoFocus
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder="Search..."
                                    className="w-full h-8 pl-8 pr-3 text-sm bg-gray-50 border border-gray-200 rounded-lg outline-none focus:border-[#1D4ED8]"
                                />
                            </div>
                        </div>
                    )}
                    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-1">
                        {filtered.length === 0 ? (
                            <p className="px-4 py-3 text-sm text-gray-400">No matches</p>
                        ) : filtered.map(o => (
                            <button
                                key={o.value}
                                type="button"
                                onClick={() => { onChange(o.value); setOpen(false); }}
                                className={`w-full text-left px-4 py-2.5 text-sm flex items-start justify-between gap-2 transition-colors ${
                                    o.value === value ? 'bg-[#0047AB] text-white' : 'text-gray-700 hover:bg-blue-50'
                                }`}
                            >
                                {/* Labels wrap (not truncate) so long option text — e.g. a
                                    battery's full name + SKU + availability — stays fully
                                    readable on narrow/mobile widths. */}
                                <span className="min-w-0 break-words whitespace-normal leading-snug">{o.label}</span>
                                {o.value === value && <Check className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                            </button>
                        ))}
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}
