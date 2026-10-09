"use client";

// Tracker ID 81 — add, rename, re-date and close acquisition campaigns, with
// how many leads each brought in. There is no delete: a campaign on a lead is
// part of that lead's locked source, so a finished one is closed instead (it
// stays on its leads and leaves the pickers).

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AcquisitionCampaign } from "@/lib/leads/acquisitionCampaigns";
import {
    CAMPAIGN_KIND_LABEL,
    CAMPAIGN_KINDS,
    LEAD_ORIGIN_LABEL,
    LEAD_ORIGINS,
    campaignRequired,
    originLabel,
    type CampaignKind,
} from "@/lib/leads/leadSourceVocab";

type Draft = { name: string; origin: string; starts_on: string; ends_on: string; notes: string };
const EMPTY: Draft = { name: "", origin: "", starts_on: "", ends_on: "", notes: "" };

async function send(url: string, method: "POST" | "PATCH", body: unknown) {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Could not save");
    return json.data;
}

const payload = (d: Draft) => ({
    name: d.name.trim(),
    origin: d.origin || null,
    starts_on: d.starts_on || null,
    ends_on: d.ends_on || null,
    notes: d.notes.trim() || null,
});

const SELECT = "h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink";

export function CampaignsView() {
    const qc = useQueryClient();
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
    const [kind, setKind] = useState<CampaignKind | "">("manual");
    const [busy, setBusy] = useState(false);

    const { data, isLoading, error } = useQuery<AcquisitionCampaign[]>({
        queryKey: ["acquisition-campaigns"],
        queryFn: async () => {
            const res = await fetch("/api/acquisition-campaigns", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load campaigns");
            return json.data.campaigns;
        },
    });
    const refresh = () => qc.invalidateQueries({ queryKey: ["acquisition-campaigns"] });

    const rows = useMemo(() => (data ?? []).filter((c) => !kind || c.kind === kind), [data, kind]);

    const run = async (fn: () => Promise<unknown>, done: string) => {
        setBusy(true);
        try {
            await fn();
            toast.success(done);
            await refresh();
            return true;
        } catch (e) {
            toast.error((e as Error).message);
            return false;
        } finally {
            setBusy(false);
        }
    };

    const create = async () => {
        if (draft.name.trim().length < 2) {
            toast.error("Give the campaign a name.");
            return;
        }
        if (await run(() => send("/api/acquisition-campaigns", "POST", payload(draft)), "Campaign added.")) {
            setDraft(EMPTY);
        }
    };

    const save = async () => {
        if (!editing) return;
        if (await run(() => send(`/api/acquisition-campaigns/${editing.id}`, "PATCH", payload(editing.draft)), "Saved.")) {
            setEditing(null);
        }
    };

    return (
        <div className="space-y-5">
            {/* New campaign */}
            <div className="rounded-xl border border-border bg-surface shadow-card p-4">
                <h2 className="text-sm font-semibold text-ink">New campaign</h2>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                    <Field label="Name">
                        <Input
                            value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            placeholder="e.g. Auto Expo 2026"
                            className="h-9 w-64"
                        />
                    </Field>
                    <Field label="Found via">
                        <select
                            value={draft.origin}
                            onChange={(e) => setDraft({ ...draft, origin: e.target.value })}
                            className={`${SELECT} w-44`}
                        >
                            <option value="">Any</option>
                            {LEAD_ORIGINS.map((o) => (
                                <option key={o} value={o}>
                                    {LEAD_ORIGIN_LABEL[o]}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Starts">
                        <Input
                            type="date"
                            value={draft.starts_on}
                            onChange={(e) => setDraft({ ...draft, starts_on: e.target.value })}
                            className="h-9 w-40"
                        />
                    </Field>
                    <Field label="Ends">
                        <Input
                            type="date"
                            value={draft.ends_on}
                            onChange={(e) => setDraft({ ...draft, ends_on: e.target.value })}
                            className="h-9 w-40"
                        />
                    </Field>
                    <Field label="Notes">
                        <Input
                            value={draft.notes}
                            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                            className="h-9 w-64"
                        />
                    </Field>
                    <Button type="button" size="sm" onClick={create} disabled={busy}>
                        Add campaign
                    </Button>
                </div>
                <p className="mt-2 text-xs text-ink-muted">
                    Set Found via so the campaign shows under that choice on the lead forms — Trade event and
                    Digital ad leads must pick one.
                </p>
            </div>

            {/* Register */}
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                    <h2 className="text-sm font-semibold text-ink">Campaigns</h2>
                    {/* ID 91 — how each campaign's leads went. */}
                    <a href="/reports?analysis=lead_sources&group=campaign" className="text-xs font-semibold text-brand-sky hover:underline">
                        Results by campaign
                    </a>
                    <select
                        value={kind}
                        onChange={(e) => setKind(e.target.value as CampaignKind | "")}
                        className={`${SELECT} ml-auto`}
                        aria-label="Kind"
                    >
                        <option value="">All kinds</option>
                        {CAMPAIGN_KINDS.map((k) => (
                            <option key={k} value={k}>
                                {CAMPAIGN_KIND_LABEL[k]}
                            </option>
                        ))}
                    </select>
                </div>

                {isLoading ? (
                    <div className="flex items-center gap-2 px-4 py-8 text-sm text-ink-muted">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </div>
                ) : error ? (
                    <p className="px-4 py-8 text-sm text-danger">{(error as Error).message}</p>
                ) : rows.length === 0 ? (
                    <p className="px-4 py-8 text-sm text-ink-muted">No campaigns here yet.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-bg/60 text-[10px] uppercase tracking-wide text-ink-muted">
                                <tr>
                                    <th className="px-4 py-2 text-left">Campaign</th>
                                    <th className="px-4 py-2 text-left">Found via</th>
                                    <th className="px-4 py-2 text-left">Kind</th>
                                    <th className="px-4 py-2 text-left">Dates</th>
                                    <th className="px-4 py-2 text-right">Leads</th>
                                    <th className="px-4 py-2 text-left">Status</th>
                                    <th className="px-4 py-2" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {rows.map((c) =>
                                    editing?.id === c.id ? (
                                        <tr key={c.id} className="bg-bg/40">
                                            <td className="px-4 py-2">
                                                <Input
                                                    value={editing.draft.name}
                                                    onChange={(e) =>
                                                        setEditing({ id: c.id, draft: { ...editing.draft, name: e.target.value } })
                                                    }
                                                    className="h-8"
                                                />
                                                <Input
                                                    value={editing.draft.notes}
                                                    onChange={(e) =>
                                                        setEditing({ id: c.id, draft: { ...editing.draft, notes: e.target.value } })
                                                    }
                                                    placeholder="Notes"
                                                    className="mt-1 h-8"
                                                />
                                            </td>
                                            <td className="px-4 py-2">
                                                <select
                                                    value={editing.draft.origin}
                                                    onChange={(e) =>
                                                        setEditing({ id: c.id, draft: { ...editing.draft, origin: e.target.value } })
                                                    }
                                                    className={SELECT}
                                                >
                                                    <option value="">Any</option>
                                                    {LEAD_ORIGINS.map((o) => (
                                                        <option key={o} value={o}>
                                                            {LEAD_ORIGIN_LABEL[o]}
                                                        </option>
                                                    ))}
                                                </select>
                                            </td>
                                            <td className="px-4 py-2 text-ink-muted">{CAMPAIGN_KIND_LABEL[c.kind] ?? c.kind}</td>
                                            <td className="px-4 py-2">
                                                <div className="flex gap-1">
                                                    <Input
                                                        type="date"
                                                        value={editing.draft.starts_on}
                                                        onChange={(e) =>
                                                            setEditing({ id: c.id, draft: { ...editing.draft, starts_on: e.target.value } })
                                                        }
                                                        className="h-8 w-36"
                                                    />
                                                    <Input
                                                        type="date"
                                                        value={editing.draft.ends_on}
                                                        onChange={(e) =>
                                                            setEditing({ id: c.id, draft: { ...editing.draft, ends_on: e.target.value } })
                                                        }
                                                        className="h-8 w-36"
                                                    />
                                                </div>
                                            </td>
                                            <td className="px-4 py-2 text-right tabular-nums">{c.lead_count}</td>
                                            <td className="px-4 py-2" />
                                            <td className="px-4 py-2 text-right whitespace-nowrap">
                                                <Button type="button" size="sm" onClick={save} disabled={busy}>
                                                    Save
                                                </Button>
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="outline"
                                                    className="ml-2"
                                                    onClick={() => setEditing(null)}
                                                    disabled={busy}
                                                >
                                                    Cancel
                                                </Button>
                                            </td>
                                        </tr>
                                    ) : (
                                        <tr key={c.id}>
                                            <td className="px-4 py-2">
                                                <div className="font-medium text-ink">{c.name}</div>
                                                {c.notes && <div className="text-xs text-ink-muted">{c.notes}</div>}
                                            </td>
                                            <td className="px-4 py-2 text-ink">
                                                {originLabel(c.origin) ?? <span className="text-ink-muted">Any</span>}
                                                {campaignRequired(c.origin) && (
                                                    <span className="ml-1 text-[10px] text-ink-muted">(required)</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-2 text-ink-muted">{CAMPAIGN_KIND_LABEL[c.kind] ?? c.kind}</td>
                                            <td className="px-4 py-2 text-ink-muted whitespace-nowrap">
                                                {c.starts_on ?? "—"}
                                                {c.ends_on ? ` → ${c.ends_on}` : ""}
                                            </td>
                                            <td className="px-4 py-2 text-right tabular-nums text-ink">{c.lead_count}</td>
                                            <td className="px-4 py-2">
                                                <span
                                                    className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold border ${
                                                        c.is_active
                                                            ? "bg-success-bg text-success border-success/30"
                                                            : "bg-bg text-ink-muted border-border"
                                                    }`}
                                                >
                                                    {c.is_active ? "Open" : "Closed"}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2 text-right whitespace-nowrap">
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        setEditing({
                                                            id: c.id,
                                                            draft: {
                                                                name: c.name,
                                                                origin: c.origin ?? "",
                                                                starts_on: c.starts_on ?? "",
                                                                ends_on: c.ends_on ?? "",
                                                                notes: c.notes ?? "",
                                                            },
                                                        })
                                                    }
                                                >
                                                    Edit
                                                </Button>
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="outline"
                                                    className="ml-2"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        run(
                                                            () =>
                                                                send(`/api/acquisition-campaigns/${c.id}`, "PATCH", {
                                                                    is_active: !c.is_active,
                                                                }),
                                                            c.is_active ? "Campaign closed." : "Campaign reopened.",
                                                        )
                                                    }
                                                >
                                                    {c.is_active ? "Close" : "Reopen"}
                                                </Button>
                                            </td>
                                        </tr>
                                    ),
                                )}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="block text-[10px] font-medium uppercase tracking-wide text-ink-muted mb-1">{label}</label>
            {children}
        </div>
    );
}
