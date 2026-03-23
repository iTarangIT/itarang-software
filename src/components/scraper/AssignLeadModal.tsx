"use client";

import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface User {
    id: string;
    name: string;
    role: string;
    email: string;
}

interface Props {
    leadId: string;
    dealerName: string;
    onClose: () => void;
    onSuccess: () => void;
}

export function AssignLeadModal({ leadId, dealerName, onClose, onSuccess }: Props) {
    const [selectedUserId, setSelectedUserId] = useState('');
    const queryClient = useQueryClient();

    // Fetch sales managers to populate the dropdown
    const { data: salesManagers = [], isLoading } = useQuery<User[]>({
        queryKey: ['users', 'sales_manager'],
        queryFn: async () => {
            const res = await fetch('/api/user/list?role=sales_manager');
            const json = await res.json();
            return json.data ?? [];
        },
    });

    const assignMutation = useMutation({
        mutationFn: async (assignedTo: string) => {
            const res = await fetch(`/api/scraper/leads/${leadId}/assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assigned_to: assignedTo }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? 'Failed to assign');
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['scraper-leads'] });
            queryClient.invalidateQueries({ queryKey: ['scraper-runs'] });
            onSuccess();
            onClose();
        },
    });

    // Close on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
                {/* Header */}
                <div className="flex items-center justify-between mb-5">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-teal-50 rounded-xl flex items-center justify-center">
                            <UserCheck className="w-5 h-5 text-teal-600" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-gray-900">Assign Lead</h2>
                            <p className="text-xs text-gray-500 truncate max-w-[220px]">{dealerName}</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Body */}
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">
                            Select Sales Manager
                        </label>
                        {isLoading ? (
                            <div className="h-10 bg-gray-100 animate-pulse rounded-lg" />
                        ) : salesManagers.length === 0 ? (
                            <p className="text-sm text-gray-500 py-2">No sales managers found.</p>
                        ) : (
                            <select
                                value={selectedUserId}
                                onChange={(e) => setSelectedUserId(e.target.value)}
                                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                            >
                                <option value="">Choose a manager...</option>
                                {salesManagers.map((m) => (
                                    <option key={m.id} value={m.id}>
                                        {m.name}
                                    </option>
                                ))}
                            </select>
                        )}
                    </div>

                    {assignMutation.isError && (
                        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                            {(assignMutation.error as Error).message}
                        </p>
                    )}
                </div>

                {/* Footer */}
                <div className="flex gap-3 mt-6">
                    <Button
                        variant="outline"
                        className="flex-1"
                        onClick={onClose}
                        disabled={assignMutation.isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        className="flex-1 bg-teal-600 hover:bg-teal-700 text-white"
                        onClick={() => selectedUserId && assignMutation.mutate(selectedUserId)}
                        disabled={!selectedUserId || assignMutation.isPending}
                    >
                        {assignMutation.isPending ? 'Assigning…' : 'Assign Lead'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
