"use client";

// BRD §0.8 — ASM territory mapping. This admin UI replaces the seed-script-only
// territory setup that Modules 1–2 (Transfer-to-ASM dropdown) depend on.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MapPin, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TerritoryRow, UserOption } from "@/lib/admin/types";

export function TerritoryManager({
    territories,
}: {
    territories: TerritoryRow[];
}) {
    const qc = useQueryClient();
    const [asmId, setAsmId] = useState("");
    const [state, setState] = useState("");
    const [city, setCity] = useState("");
    const [busy, setBusy] = useState(false);

    const asmsQuery = useQuery<{ success: true; data: { users: UserOption[] } }>({
        queryKey: ["admin-user-options", "asm"],
        queryFn: async () => {
            const res = await fetch("/api/admin/users?roles=asm", {
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Failed to load ASMs");
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
    });
    const asms = asmsQuery.data?.data.users ?? [];

    function refresh() {
        qc.invalidateQueries({ queryKey: ["admin-settings"] });
    }

    async function add() {
        if (!asmId || state.trim().length < 2) {
            toast.error("Pick an ASM and enter a state.");
            return;
        }
        setBusy(true);
        try {
            const res = await fetch("/api/admin/settings/territories", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    asm_id: asmId,
                    state: state.trim(),
                    city: city.trim() || null,
                }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to add");
            }
            toast.success("Territory added.");
            setState("");
            setCity("");
            refresh();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function remove(t: TerritoryRow) {
        try {
            const res = await fetch(
                `/api/admin/settings/territories/${t.territory_id}`,
                { method: "DELETE" },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed");
            }
            refresh();
        } catch (e) {
            toast.error((e as Error).message);
        }
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-bg/50 p-3">
                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        ASM
                    </label>
                    <select
                        value={asmId}
                        onChange={(e) => setAsmId(e.target.value)}
                        className="h-9 rounded-md border border-border px-2 text-sm min-w-[180px]"
                    >
                        <option value="">Select an ASM…</option>
                        {asms.map((a) => (
                            <option key={a.user_id} value={a.user_id}>
                                {a.name ?? a.email}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        State
                    </label>
                    <Input
                        value={state}
                        onChange={(e) => setState(e.target.value)}
                        placeholder="e.g. Maharashtra"
                        className="h-9 w-44"
                    />
                </div>
                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        City <span className="text-ink-muted">(optional)</span>
                    </label>
                    <Input
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        placeholder="Whole state if blank"
                        className="h-9 w-44"
                    />
                </div>
                <Button type="button" size="sm" onClick={add} disabled={busy}>
                    {busy ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                        <Plus className="h-3.5 w-3.5 mr-1" />
                    )}
                    Add Territory
                </Button>
            </div>

            <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="text-left px-4 py-2.5 font-semibold">ASM</th>
                            <th className="text-left px-4 py-2.5 font-semibold">State</th>
                            <th className="text-left px-4 py-2.5 font-semibold">City</th>
                            <th className="px-4 py-2.5"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {territories.length === 0 && (
                            <tr>
                                <td
                                    colSpan={4}
                                    className="px-4 py-8 text-center text-ink-muted"
                                >
                                    <MapPin className="h-6 w-6 mx-auto mb-1.5" />
                                    No territories mapped yet.
                                </td>
                            </tr>
                        )}
                        {territories.map((t) => (
                            <tr key={t.territory_id}>
                                <td className="px-4 py-2.5 text-ink">
                                    {t.asm_name ?? "(unknown ASM)"}
                                </td>
                                <td className="px-4 py-2.5 text-ink">
                                    {t.state}
                                </td>
                                <td className="px-4 py-2.5 text-ink">
                                    {t.city ?? (
                                        <span className="text-ink-muted">
                                            Whole state
                                        </span>
                                    )}
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                    <button
                                        type="button"
                                        onClick={() => remove(t)}
                                        className="inline-flex items-center gap-1 text-xs font-medium text-danger hover:underline"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                        Remove
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
