'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ScrapeModalProps {
    open: boolean;
    onClose: () => void;
    onComplete?: () => void;
}

interface ScrapeResult {
    batchId: string;
    totalResults: number;
    newLeadsCreated: number;
    duplicatesFound: number;
    enrichedExisting: number;
    noPhoneCount: number;
}

export function ScrapeModal({ open, onClose, onComplete }: ScrapeModalProps) {
    const [query, setQuery] = useState('');
    const [city, setCity] = useState('');
    const [state, setState] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<ScrapeResult | null>(null);
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!query.trim()) {
            setError('Search query is required');
            return;
        }

        setLoading(true);
        setError('');
        setResult(null);

        try {
            const res = await fetch('/api/leads/scrape/google-maps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: query.trim(), city: city.trim() || undefined, state: state.trim() || undefined }),
            });

            const data = await res.json();
            if (!data.success) throw new Error(data.error?.message || 'Scrape failed');

            setResult(data.data);
            onComplete?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong');
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        setQuery('');
        setCity('');
        setState('');
        setResult(null);
        setError('');
        onClose();
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
                <h2 className="text-lg font-bold text-gray-900 mb-4">Scrape from Google Maps</h2>

                {!result ? (
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Search Query *</label>
                            <Input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder='e.g. "EV battery dealer Jaipur"'
                                disabled={loading}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                                <Input
                                    value={city}
                                    onChange={(e) => setCity(e.target.value)}
                                    placeholder="Jaipur"
                                    disabled={loading}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                                <Input
                                    value={state}
                                    onChange={(e) => setState(e.target.value)}
                                    placeholder="Rajasthan"
                                    disabled={loading}
                                />
                            </div>
                        </div>

                        {error && <p className="text-sm text-red-600">{error}</p>}

                        <div className="flex gap-3 justify-end pt-2">
                            <Button type="button" variant="outline" onClick={handleClose} disabled={loading}>Cancel</Button>
                            <Button type="submit" disabled={loading}>
                                {loading ? 'Scraping...' : 'Start Scrape'}
                            </Button>
                        </div>
                    </form>
                ) : (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <StatCard label="Total Found" value={result.totalResults} />
                            <StatCard label="New Leads" value={result.newLeadsCreated} color="text-emerald-600" />
                            <StatCard label="Duplicates" value={result.duplicatesFound} color="text-amber-600" />
                            <StatCard label="Enriched" value={result.enrichedExisting} color="text-blue-600" />
                        </div>
                        {result.noPhoneCount > 0 && (
                            <p className="text-xs text-gray-500">{result.noPhoneCount} leads had no phone and were marked do-not-call.</p>
                        )}
                        <div className="flex justify-end pt-2">
                            <Button onClick={handleClose}>Done</Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
    return (
        <div className="rounded-lg border border-gray-200 p-3 text-center">
            <p className={`text-2xl font-bold ${color || 'text-gray-900'}`}>{value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{label}</p>
        </div>
    );
}
