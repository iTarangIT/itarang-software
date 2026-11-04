"use client";

// Settings → ASM Territories → automatic routing (E-367). The switch that sends
// an AI-qualified lead (or one that agreed to a callback / asked for a person)
// straight to the ASM whose territory covers its city, plus the two lists that
// make it trustworthy: places with no ASM (those leads went to the ISRs) and
// the last 50 decisions with the rule that made each one.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Route } from "lucide-react";

type Rule = "territory_city" | "territory_state" | "isr_round_robin" | "unassigned";
type RecentRow = {
    id: string;
    lead_id: string;
    lead_name: string | null;
    kind: string;
    rule: Rule;
    state: string | null;
    city: string | null;
    chosen_name: string | null;
    chosen_role: string | null;
    created_at: string;
};
type Uncovered = { state: string | null; city: string | null; leads: number; last_at: string };
type Data = {
    settings: { enabled: boolean; updatedAt: string | null };
    logReady: boolean;
    recent: RecentRow[];
    uncovered: Uncovered[];
};

export const TERRITORY_ROUTING_QUERY_KEY = ["territory-routing"];

const RULE_LABEL: Record<Rule, string> = {
    territory_city: "City ASM",
    territory_state: "State ASM",
    isr_round_robin: "No ASM → ISR",
    unassigned: "Nobody available",
};
const RULE_TONE: Record<Rule, string> = {
    territory_city: "bg-emerald-50 text-emerald-700",
    territory_state: "bg-sky-50 text-sky-700",
    isr_round_robin: "bg-amber-50 text-amber-700",
    unassigned: "bg-red-50 text-red-700",
};

const when = (s: string) =>
    new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const placeText = (state: string | null, city: string | null) =>
    city && state ? `${city}, ${state}` : city ?? state ?? "No location on the lead";

export function TerritoryRoutingPanel() {
    const qc = useQueryClient();
    const [saving, setSaving] = useState(false);

    const q = useQuery({
        queryKey: TERRITORY_ROUTING_QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/territory-routing", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load");
            return json.data as Data;
        },
    });

    async function toggle(enabled: boolean) {
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/territory-routing", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to save");
            toast.success(enabled ? "Qualified leads now go to the area ASM." : "Automatic ASM routing is off.");
            await qc.invalidateQueries({ queryKey: TERRITORY_ROUTING_QUERY_KEY });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    }

    if (q.isLoading) {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading routing…
            </div>
        );
    }
    if (q.error || !q.data) {
        return (
            <div className="rounded-lg border border-border p-4 text-sm text-red-600">
                Failed to load the routing settings.
            </div>
        );
    }

    const { settings, logReady, recent, uncovered } = q.data;

    return (
        <div className="space-y-3 rounded-lg border border-border p-4">
            <label className="flex items-start gap-3">
                <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={settings.enabled}
                    disabled={saving}
                    onChange={(e) => toggle(e.target.checked)}
                />
                <span className="text-sm text-ink">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                        <Route className="h-4 w-4" />
                        Auto-assign AI-qualified leads to the area ASM
                        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    </span>
                    <span className="block text-xs text-ink-muted mt-0.5">
                        When the AI dialer qualifies a lead, or the dealer agrees to a callback or asks for a person,
                        and nobody owns the lead yet, it goes straight to the ASM mapped below for the lead&apos;s city.
                        A city mapping beats a whole-state one; ASMs sharing a place take turns. With no ASM for the
                        place, the lead goes to the next ISR on the AI callbacks list. Complaints are never routed to
                        an ASM.
                    </span>
                    {settings.updatedAt && (
                        <span className="block text-[11px] text-ink-muted mt-0.5">
                            Last changed {when(settings.updatedAt)}
                        </span>
                    )}
                </span>
            </label>

            {!logReady && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    The routing log (E-367) is not applied on this database yet. Routing still works, but ASMs
                    sharing a place are picked by name rather than in turn, and the lists below stay empty.
                </p>
            )}

            {logReady && uncovered.length > 0 && (
                <div>
                    <div className="text-xs font-semibold text-ink mb-1">
                        Not covered: qualified leads with no ASM, last 30 days
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {uncovered.map((u) => (
                            <span
                                key={`${u.state}|${u.city}`}
                                title={`Last ${when(u.last_at)}`}
                                className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs text-amber-800"
                            >
                                {placeText(u.state, u.city)} · {u.leads}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {logReady && (
                <details className="group">
                    <summary className="cursor-pointer text-xs font-semibold text-ink">
                        Recent automatic assignments ({recent.length})
                    </summary>
                    {recent.length === 0 ? (
                        <p className="mt-2 text-xs text-ink-muted">None yet.</p>
                    ) : (
                        <div className="mt-2 max-h-80 overflow-auto rounded-md border border-border">
                            <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-bg text-[10px] uppercase tracking-wide text-ink-muted">
                                    <tr>
                                        <th className="text-left px-3 py-2 font-semibold">When</th>
                                        <th className="text-left px-3 py-2 font-semibold">Lead</th>
                                        <th className="text-left px-3 py-2 font-semibold">Place</th>
                                        <th className="text-left px-3 py-2 font-semibold">Rule</th>
                                        <th className="text-left px-3 py-2 font-semibold">Assigned to</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {recent.map((r) => (
                                        <tr key={r.id}>
                                            <td className="px-3 py-1.5 whitespace-nowrap text-ink-muted">{when(r.created_at)}</td>
                                            <td className="px-3 py-1.5">
                                                <a href={`/leads?lead=${r.lead_id}`} className="text-brand hover:underline">
                                                    {r.lead_name ?? r.lead_id}
                                                </a>
                                                {r.kind === "sales" && <span className="ml-1 text-ink-muted">(callback)</span>}
                                            </td>
                                            <td className="px-3 py-1.5 text-ink">{placeText(r.state, r.city)}</td>
                                            <td className="px-3 py-1.5">
                                                <span className={`rounded px-1.5 py-0.5 ${RULE_TONE[r.rule] ?? ""}`}>
                                                    {RULE_LABEL[r.rule] ?? r.rule}
                                                </span>
                                            </td>
                                            <td className="px-3 py-1.5 text-ink">
                                                {r.chosen_name ?? <span className="text-ink-muted">—</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </details>
            )}
        </div>
    );
}
