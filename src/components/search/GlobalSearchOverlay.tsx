"use client";

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { X, Search, Clock, Hash } from 'lucide-react';
import { useDebounce } from '@/lib/useDebounce';

type SearchItem = {
    id: string;
    label: string;
    subLabel?: string;
    href: string;
};

type SearchResponse = {
    success: boolean;
    data: {
        leads: SearchItem[];
        loans: SearchItem[];
        inventory: SearchItem[];
        assets: SearchItem[];
        services: SearchItem[];
        campaigns: SearchItem[];
    };
};

const RECENTS_KEY = 'itarang_global_search_recents_v1';

function loadRecents(): string[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(RECENTS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.slice(0, 10) : [];
    } catch {
        return [];
    }
}

function saveRecent(query: string) {
    if (typeof window === 'undefined') return;
    const q = query.trim();
    if (!q) return;
    const existing = loadRecents();
    const next = [q, ...existing.filter((x) => x !== q)].slice(0, 10);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

export function GlobalSearchOverlay({
    isOpen,
    onClose,
}: {
    isOpen: boolean;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const debounced = useDebounce(query, 250);
    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState<SearchResponse['data'] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [recents, setRecents] = useState<string[]>([]);

    useEffect(() => {
        if (!isOpen) return;
        setRecents(loadRecents());
        // reset when opened
        setQuery('');
        setResults(null);
        setError(null);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const q = debounced.trim();
        if (q.length < 2) {
            setResults(null);
            setError(null);
            return;
        }

        let cancelled = false;

        (async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`/api/search/global?q=${encodeURIComponent(q)}`, {
                    credentials: 'include',
                });
                const data = (await res.json()) as SearchResponse;
                if (!cancelled) {
                    if (res.ok && data?.success) setResults(data.data);
                    else setError('Search failed. Please try again.');
                }
            } catch {
                if (!cancelled) setError('Connection lost. Please try again.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [debounced, isOpen]);

    // Close on ESC
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, onClose]);

    const sections = useMemo(() => {
        if (!results) return [];
        return [
            { title: 'Leads', key: 'leads' as const, items: results.leads },
            { title: 'Loans', key: 'loans' as const, items: results.loans },
            { title: 'Inventory', key: 'inventory' as const, items: results.inventory },
            { title: 'Deployed Assets', key: 'assets' as const, items: results.assets },
            { title: 'Service Tickets', key: 'services' as const, items: results.services },
            { title: 'Campaigns', key: 'campaigns' as const, items: results.campaigns },
        ].filter((s) => s.items?.length);
    }, [results]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

            {/* Dialog */}
            <div className="absolute inset-0 flex items-start justify-center p-4 md:p-10">
                <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input
                                autoFocus
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search leads, loans, assets, inventory, campaigns…"
                                className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-gray-50 border border-transparent focus:bg-white focus:border-brand-200 focus:ring-2 focus:ring-brand-100 outline-none text-sm"
                            />
                            {query && (
                                <button
                                    onClick={() => setQuery('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
                                    aria-label="Clear search"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                        <button
                            onClick={onClose}
                            className="p-2 rounded-xl hover:bg-gray-100 text-gray-500"
                            aria-label="Close search"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="max-h-[70vh] overflow-y-auto">
                        {/* Helper / recent */}
                        {query.trim().length < 2 && (
                            <div className="p-5">
                                <div className="flex items-center gap-2 text-xs font-semibold text-gray-400 tracking-widest uppercase mb-3">
                                    <Clock className="w-4 h-4" />
                                    Recent searches
                                </div>
                                {recents.length ? (
                                    <div className="flex flex-wrap gap-2">
                                        {recents.map((r) => (
                                            <button
                                                key={r}
                                                onClick={() => setQuery(r)}
                                                className="px-3 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm"
                                            >
                                                {r}
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-sm text-gray-500">
                                        Start typing to search. Try: customer name, mobile, Lead ID, Loan ID, Asset/Inventory ID.
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Loading / Error */}
                        {query.trim().length >= 2 && (
                            <div className="px-5 py-3">
                                {loading && (
                                    <div className="flex items-center gap-2 text-sm text-gray-500">
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-600" />
                                        Searching…
                                    </div>
                                )}
                                {!loading && error && <div className="text-sm text-red-600">{error}</div>}
                            </div>
                        )}

                        {/* Results */}
                        {!loading && !error && query.trim().length >= 2 && (
                            <div className="px-2 pb-2">
                                {sections.length === 0 ? (
                                    <div className="p-6 text-sm text-gray-500">No results found.</div>
                                ) : (
                                    <div className="space-y-2">
                                        {sections.map((section) => (
                                            <div key={section.key} className="bg-white">
                                                <div className="px-4 pt-4 pb-2 text-xs font-semibold text-gray-400 tracking-widest uppercase">
                                                    {section.title}
                                                </div>
                                                <div className="space-y-1">
                                                    {section.items.map((item) => (
                                                        <Link
                                                            key={item.id}
                                                            href={item.href}
                                                            onClick={() => {
                                                                saveRecent(query);
                                                                onClose();
                                                            }}
                                                            className="flex items-start gap-3 px-4 py-3 rounded-xl hover:bg-gray-50 transition-colors"
                                                        >
                                                            <div className="mt-0.5 w-7 h-7 rounded-lg bg-brand-50 text-brand-700 flex items-center justify-center flex-shrink-0">
                                                                <Hash className="w-4 h-4" />
                                                            </div>
                                                            <div className="min-w-0">
                                                                <div className="text-sm font-semibold text-gray-900 truncate">{item.label}</div>
                                                                {item.subLabel && <div className="text-xs text-gray-500 truncate">{item.subLabel}</div>}
                                                            </div>
                                                        </Link>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}