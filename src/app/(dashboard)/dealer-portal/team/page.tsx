'use client';

// E-277 — dealer-portal "My Team": manage the WhatsApp salespersons who can
// create leads on the dealer's behalf. Mirrors the WhatsApp "My Team" chat
// menu; both call the same /api/dealer/team CRUD.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Users } from 'lucide-react';

type TeamMember = {
    id: string;
    waPhone: string;
    displayName: string;
    isActive: boolean;
    addedVia: string;
    createdAt: string;
    deactivatedAt: string | null;
};

function maskPhone(waPhone: string): string {
    const tail = waPhone.slice(-3);
    const head = waPhone.slice(0, 4);
    return `+${head.slice(0, 2)} ${head.slice(2)}•••••${tail}`;
}

export default function DealerTeamPage() {
    const [team, setTeam] = useState<TeamMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const [phone, setPhone] = useState('');
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [removingId, setRemovingId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/dealer/team');
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message || 'Failed to load team');
            setTeam(json.data?.team ?? json.team ?? []);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load team');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    async function onAdd(e: React.FormEvent) {
        e.preventDefault();
        setSubmitting(true);
        setError(null);
        setNotice(null);
        try {
            const res = await fetch('/api/dealer/team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, name }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message || 'Could not add salesperson');
            setPhone('');
            setName('');
            setNotice(
                `${name.trim()} added. Ask them to send "hi" to your iTarang WhatsApp number to get started.`,
            );
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not add salesperson');
        } finally {
            setSubmitting(false);
        }
    }

    async function onRemove(member: TeamMember) {
        if (
            !window.confirm(
                `Remove ${member.displayName}? They immediately lose WhatsApp access. Their leads stay with you.`,
            )
        ) {
            return;
        }
        setRemovingId(member.id);
        setError(null);
        setNotice(null);
        try {
            const res = await fetch(`/api/dealer/team/${member.id}`, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message || 'Could not remove salesperson');
            setNotice(`${member.displayName} removed.`);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove salesperson');
        } finally {
            setRemovingId(null);
        }
    }

    const active = team.filter((m) => m.isActive);
    const removed = team.filter((m) => !m.isActive);

    return (
        <div className="p-6 max-w-4xl mx-auto space-y-6">
            <div className="flex items-center gap-3">
                <Users className="h-7 w-7 text-blue-600" />
                <div>
                    <h1 className="text-2xl font-semibold text-gray-900">My Team</h1>
                    <p className="text-sm text-gray-500">
                        Salespersons on your team can create and work customer leads from
                        their own WhatsApp. Every lead they create shows up in your account.
                    </p>
                </div>
            </div>

            {error && (
                <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                    {error}
                </div>
            )}
            {notice && (
                <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
                    {notice}
                </div>
            )}

            <form
                onSubmit={onAdd}
                className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col sm:flex-row gap-3 sm:items-end"
            >
                <div className="flex-1">
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                        WhatsApp number
                    </label>
                    <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="10-digit mobile, e.g. 9876543210"
                        required
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                </div>
                <div className="flex-1">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Salesperson name"
                        required
                        minLength={2}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                </div>
                <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                    {submitting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Plus className="h-4 w-4" />
                    )}
                    Add salesperson
                </button>
            </form>

            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                            <tr>
                                <th className="px-4 py-3">Name</th>
                                <th className="px-4 py-3">WhatsApp</th>
                                <th className="px-4 py-3">Added</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {loading ? (
                                <tr>
                                    <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                                        <Loader2 className="h-5 w-5 animate-spin inline" /> Loading…
                                    </td>
                                </tr>
                            ) : active.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                                        No salespersons yet — add one above, then ask them to send
                                        &quot;hi&quot; to your iTarang WhatsApp number.
                                    </td>
                                </tr>
                            ) : (
                                active.map((m) => (
                                    <tr key={m.id}>
                                        <td className="px-4 py-3 font-medium text-gray-900">
                                            {m.displayName}
                                        </td>
                                        <td className="px-4 py-3 text-gray-600">{maskPhone(m.waPhone)}</td>
                                        <td className="px-4 py-3 text-gray-500">
                                            {new Date(m.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                                                Active
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <button
                                                onClick={() => void onRemove(m)}
                                                disabled={removingId === m.id}
                                                className="inline-flex items-center gap-1 text-red-600 hover:text-red-700 disabled:opacity-50"
                                                title="Remove — access is revoked immediately"
                                            >
                                                {removingId === m.id ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <Trash2 className="h-4 w-4" />
                                                )}
                                                Remove
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {removed.length > 0 && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <h2 className="text-sm font-medium text-gray-700 mb-2">Removed</h2>
                    <ul className="text-sm text-gray-500 space-y-1">
                        {removed.map((m) => (
                            <li key={m.id}>
                                {m.displayName} — {maskPhone(m.waPhone)}
                                {m.deactivatedAt
                                    ? ` · removed ${new Date(m.deactivatedAt).toLocaleDateString()}`
                                    : ''}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
