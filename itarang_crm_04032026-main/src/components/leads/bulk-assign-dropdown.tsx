'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

interface BulkAssignDropdownProps {
    selectedLeadIds: string[];
    onAssigned?: () => void;
}

interface SalesUser {
    id: string;
    name: string;
    role: string;
}

export function BulkAssignDropdown({ selectedLeadIds, onAssigned }: BulkAssignDropdownProps) {
    const [managers, setManagers] = useState<SalesUser[]>([]);
    const [selectedManager, setSelectedManager] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        fetch('/api/users?role=sales_manager')
            .then((r) => r.json())
            .then((d) => {
                if (d.success) setManagers(d.data || []);
            })
            .catch(() => {});
    }, []);

    const handleAssign = async () => {
        if (!selectedManager || selectedLeadIds.length === 0) return;

        setLoading(true);
        setError('');

        try {
            const res = await fetch('/api/leads/bulk-assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadIds: selectedLeadIds, lead_owner: selectedManager }),
            });

            const data = await res.json();
            if (!data.success) throw new Error(data.error?.message || 'Assignment failed');

            setSelectedManager('');
            onAssigned?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex items-center gap-2">
            <Select
                value={selectedManager}
                onChange={(e) => setSelectedManager(e.target.value)}
                className="w-48"
                disabled={loading || selectedLeadIds.length === 0}
            >
                <option value="">Assign to...</option>
                {managers.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                ))}
            </Select>
            <Button
                size="sm"
                onClick={handleAssign}
                disabled={!selectedManager || selectedLeadIds.length === 0 || loading}
            >
                {loading ? 'Assigning...' : `Assign (${selectedLeadIds.length})`}
            </Button>
            {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
    );
}
