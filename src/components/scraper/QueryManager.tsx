"use client";

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, ToggleLeft, ToggleRight, Pencil, Check, X } from 'lucide-react';

interface ScraperQuery {
    id: string;
    query_text: string;
    is_active: boolean;
    created_by_name: string;
    created_at: string;
}

async function fetchQueries(): Promise<ScraperQuery[]> {
    const res = await fetch('/api/scraper/queries');
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message ?? 'Failed to fetch queries');
    return json.data;
}

export function QueryManager() {
    const queryClient = useQueryClient();
    const [newText, setNewText] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState('');

    const { data: queries = [], isLoading } = useQuery<ScraperQuery[]>({
        queryKey: ['scraper-queries'],
        queryFn: fetchQueries,
    });

    const addMutation = useMutation({
        mutationFn: async (query_text: string) => {
            const res = await fetch('/api/scraper/queries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query_text }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? 'Failed to add query');
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['scraper-queries'] });
            setNewText('');
        },
    });

    const updateMutation = useMutation({
        mutationFn: async ({ id, ...body }: { id: string; query_text?: string; is_active?: boolean }) => {
            const res = await fetch(`/api/scraper/queries/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? 'Failed to update query');
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['scraper-queries'] });
            setEditingId(null);
            setEditText('');
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/scraper/queries/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? 'Failed to delete query');
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['scraper-queries'] });
        },
    });

    function handleAdd() {
        const text = newText.trim();
        if (!text) return;
        addMutation.mutate(text);
    }

    function handleEditStart(q: ScraperQuery) {
        setEditingId(q.id);
        setEditText(q.query_text);
    }

    function handleEditSave(id: string) {
        const text = editText.trim();
        if (!text) return;
        updateMutation.mutate({ id, query_text: text });
    }

    function handleEditCancel() {
        setEditingId(null);
        setEditText('');
    }

    function handleToggle(q: ScraperQuery) {
        updateMutation.mutate({ id: q.id, is_active: !q.is_active });
    }

    function handleDelete(id: string) {
        if (!confirm('Delete this search query?')) return;
        deleteMutation.mutate(id);
    }

    return (
        <div className="space-y-4">
            {/* Add new query */}
            <div className="flex gap-2">
                <input
                    type="text"
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                    placeholder="Enter search query (e.g. 3-wheeler battery dealer Mumbai)"
                    className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                />
                <Button
                    onClick={handleAdd}
                    disabled={addMutation.isPending || !newText.trim()}
                    className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
                >
                    <Plus className="w-4 h-4" />
                    Add
                </Button>
            </div>

            {/* Query list */}
            {isLoading ? (
                <p className="text-sm text-gray-400 py-4 text-center">Loading queries…</p>
            ) : queries.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">No search queries yet. Add one above.</p>
            ) : (
                <ul className="space-y-2">
                    {queries.map((q) => (
                        <li
                            key={q.id}
                            className={`flex items-center gap-3 px-4 py-3 bg-white border border-gray-100 rounded-xl shadow-sm transition-opacity ${
                                q.is_active ? '' : 'opacity-60'
                            }`}
                        >
                            {/* Toggle */}
                            <button
                                onClick={() => handleToggle(q)}
                                disabled={updateMutation.isPending}
                                className="shrink-0 text-gray-400 hover:text-teal-600 transition-colors"
                                title={q.is_active ? 'Deactivate' : 'Activate'}
                            >
                                {q.is_active ? (
                                    <ToggleRight className="w-6 h-6 text-teal-600" />
                                ) : (
                                    <ToggleLeft className="w-6 h-6" />
                                )}
                            </button>

                            {/* Query text / inline edit */}
                            {editingId === q.id ? (
                                <div className="flex flex-1 items-center gap-2">
                                    <input
                                        type="text"
                                        value={editText}
                                        onChange={(e) => setEditText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleEditSave(q.id);
                                            if (e.key === 'Escape') handleEditCancel();
                                        }}
                                        autoFocus
                                        className="flex-1 px-2 py-1 text-sm border border-teal-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                                    />
                                    <button
                                        onClick={() => handleEditSave(q.id)}
                                        disabled={updateMutation.isPending}
                                        className="text-teal-600 hover:text-teal-700"
                                        title="Save"
                                    >
                                        <Check className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={handleEditCancel}
                                        className="text-gray-400 hover:text-gray-600"
                                        title="Cancel"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <span className="flex-1 text-sm text-gray-800 truncate">{q.query_text}</span>
                                    <button
                                        onClick={() => handleEditStart(q)}
                                        className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
                                        title="Edit"
                                    >
                                        <Pencil className="w-4 h-4" />
                                    </button>
                                </>
                            )}

                            {/* Delete */}
                            <button
                                onClick={() => handleDelete(q.id)}
                                disabled={deleteMutation.isPending}
                                className="shrink-0 text-gray-400 hover:text-red-500 transition-colors"
                                title="Delete"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
