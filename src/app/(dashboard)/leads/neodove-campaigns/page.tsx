// NeoDove campaigns — list + create (E-224).
//
// The landing page for the NeoDove sidebar item. Until this existed,
// GET /api/neodove/campaigns had no consumer at all and a campaign could only
// be created by hand-rolling a POST, which is why nothing NeoDove-related was
// reachable from the UI.
//
// WHAT THIS PAGE CAN AND CANNOT SHOW. NeoDove has no read API. Every number
// here is OURS — what we pushed and what their webhook told us — never a live
// read of their system. That is why "Delivered" is labelled from
// neodove_lead_links and not called "leads in NeoDove": a push that NeoDove
// answered 200 to may still have been discarded on their side (verified
// 2026-08-01 — see docs/neodove-contract.md §2). The honest confirmation is a
// CSV reconciliation run, not this table.

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
    AlertTriangle,
    ChevronRight,
    History,
    Info,
    Plus,
    Upload,
} from "lucide-react";
import { NeodoveCampaignModal } from "@/components/leads/neodove-campaign-modal";

type CampaignRow = {
    id: string;
    name: string;
    neodove_campaign_name: string | null;
    status: string;
    push_endpoint_ref: string | null;
    /** The env var behind push_endpoint_ref actually resolves on the server. */
    is_wired: boolean;
    /** Names of other campaigns pushing through the same endpoint. */
    endpoint_shared_with?: string[];
    total_pushed: number;
    push_failed: number;
    // Both server-derived — see the comments in GET /api/neodove/campaigns.
    // `delivered` counts distinct leads (total_pushed counts attempts) and
    // `dispositions_received` counts the touchpoints that exist rather than a
    // counter that only moves when NeoDove's campaign name matches ours.
    delivered: number;
    dispositions_received: number;
    audience_filter: unknown;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    created_by_name: string | null;
};

const STATUS_STYLE: Record<string, string> = {
    draft: "bg-zinc-100 text-zinc-700",
    pushing: "bg-amber-50 text-amber-700",
    active: "bg-emerald-50 text-emerald-700",
    paused: "bg-zinc-100 text-zinc-600",
    completed: "bg-blue-50 text-blue-700",
};

function fmtDate(s: string | null): string {
    if (!s) return "—";
    return new Date(s).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function segmentOf(filter: unknown): string {
    if (!filter || typeof filter !== "object") return "All leads";
    const f = filter as { category?: string; states?: string[] };
    const parts: string[] = [];
    if (f.category && f.category !== "all") parts.push(f.category);
    if (Array.isArray(f.states) && f.states.length) {
        parts.push(f.states.length === 1 ? f.states[0] : `${f.states.length} states`);
    }
    return parts.length ? parts.join(" · ") : "All leads";
}

export default function NeodoveCampaignsPage() {
    const router = useRouter();
    const [showCreate, setShowCreate] = useState(false);

    const { data, isLoading, isError, error, refetch } = useQuery<CampaignRow[]>({
        queryKey: ["neodove-campaigns"],
        queryFn: async () => {
            const res = await fetch("/api/neodove/campaigns");
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Failed to load campaigns");
            }
            return json.data;
        },
        // 'pushing' is the only transient state — a drain is running in the
        // background and the counters move while it does.
        refetchInterval: (q) =>
            (q.state.data ?? []).some((c) => c.status === "pushing") ? 4000 : false,
    });

    const rows = data ?? [];

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 min-h-screen bg-gray-50">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                        NeoDove
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">
                        Hand leads to the telecalling team in NeoDove, and track what
                        came back.
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <Link
                        href="/leads/neodove-campaigns/activity"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                        <History className="w-4 h-4" /> Sync activity
                    </Link>
                    <Link
                        href="/leads/neodove-campaigns/reconcile"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                        <Upload className="w-4 h-4" /> Reconcile
                    </Link>
                    <button
                        onClick={() => setShowCreate(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800"
                    >
                        <Plus className="w-4 h-4" /> New campaign
                    </button>
                </div>
            </div>

            {/* Stated once, prominently, because every number below is subject to
                it and a reader who assumes these are live NeoDove figures will
                draw wrong conclusions from them. */}
            <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-blue-900 flex gap-2">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                    NeoDove cannot be queried — it has no read API. These counters are
                    what <strong>we</strong> sent and what their webhook sent back, not
                    a live view of their system. To confirm what actually landed, run a
                    CSV reconciliation from a campaign.
                </span>
            </div>

            {isLoading && (
                <p className="mt-8 text-sm text-gray-500">Loading campaigns…</p>
            )}

            {isError && (
                <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
                    <p className="text-sm text-rose-700">
                        {error instanceof Error ? error.message : "Failed to load."}
                    </p>
                    <p className="mt-1 text-xs text-rose-600">
                        If this mentions a relation that does not exist, migration
                        E-224 has not been applied to this database — run{" "}
                        <code className="font-mono">node scripts/apply-e224.mjs</code>.
                    </p>
                </div>
            )}

            {!isLoading && !isError && rows.length === 0 && (
                <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white px-6 py-14 text-center">
                    <p className="text-sm text-gray-600 font-medium">
                        No NeoDove campaigns yet
                    </p>
                    <p className="text-xs text-gray-500 mt-1.5 max-w-md mx-auto">
                        A campaign maps an audience here to a campaign that already
                        exists in NeoDove. Create one, preview the audience, then push.
                    </p>
                    <button
                        onClick={() => setShowCreate(true)}
                        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                        <Plus className="w-4 h-4" /> New campaign
                    </button>
                </div>
            )}

            {rows.length > 0 && (
                <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wider">
                            <tr>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Campaign
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Status
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Segment
                                </th>
                                <th className="px-4 py-3 text-right font-semibold">
                                    Delivered
                                </th>
                                <th className="px-4 py-3 text-right font-semibold">
                                    Failed
                                </th>
                                <th className="px-4 py-3 text-right font-semibold">
                                    Dispositions
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Created
                                </th>
                                <th className="px-4 py-3 text-right" aria-label="Open" />
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((c) => {
                                const href = `/leads/neodove-campaigns/${c.id}`;
                                return (
                                    <tr
                                        key={c.id}
                                        onClick={() => router.push(href)}
                                        className="border-t border-gray-100 cursor-pointer transition-colors hover:bg-gray-50 group"
                                    >
                                        <td className="px-4 py-3">
                                            <Link
                                                href={href}
                                                onClick={(e) => e.stopPropagation()}
                                                className="font-medium text-gray-900 hover:text-emerald-700 hover:underline"
                                            >
                                                {c.name}
                                            </Link>
                                            <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5">
                                                {c.neodove_campaign_name ?? (
                                                    <span className="text-amber-600">
                                                        no NeoDove campaign recorded
                                                    </span>
                                                )}
                                                {/* A campaign with no WORKING endpoint
                                                    can never push — surfaced here so it
                                                    is visible without opening it.
                                                    `is_wired` now means the env var
                                                    actually resolves on the server, so
                                                    the two cases are worth telling
                                                    apart: nothing configured is an
                                                    unfinished setup, a ref pointing at
                                                    an unset variable is a broken one
                                                    that LOOKS finished. */}
                                                {!c.is_wired && (
                                                    <span className="inline-flex items-center gap-1 text-amber-600">
                                                        <AlertTriangle className="w-3 h-3" />
                                                        {c.push_endpoint_ref
                                                            ? `${c.push_endpoint_ref} not set on this server`
                                                            : "not wired"}
                                                    </span>
                                                )}
                                                {/* Two campaigns, one endpoint = one
                                                    destination: the URL routes the
                                                    lead, nothing in the push body
                                                    names a campaign. */}
                                                {(c.endpoint_shared_with?.length ?? 0) >
                                                    0 && (
                                                    <span
                                                        className="inline-flex items-center gap-1 text-amber-600"
                                                        title={`Same NeoDove destination as ${c.endpoint_shared_with?.join(", ")}`}
                                                    >
                                                        <AlertTriangle className="w-3 h-3" />
                                                        shares endpoint
                                                    </span>
                                                )}
                                                {/* The "priority dial" badge stood
                                                    here. It marked where per-lead
                                                    "Call now" landed; with that
                                                    button gone the badge pointed at
                                                    a destination nothing routes to. */}
                                            </p>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span
                                                className={`px-2 py-0.5 text-[11px] font-medium rounded-full ${
                                                    STATUS_STYLE[c.status] ??
                                                    "bg-gray-100 text-gray-700"
                                                }`}
                                            >
                                                {c.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-gray-700">
                                            {segmentOf(c.audience_filter)}
                                        </td>
                                        <td
                                            className="px-4 py-3 text-right tabular-nums text-emerald-700"
                                            title={
                                                c.total_pushed !== c.delivered
                                                    ? `${c.total_pushed} push attempts across ${c.delivered} distinct leads`
                                                    : undefined
                                            }
                                        >
                                            {c.delivered}
                                        </td>
                                        <td className="px-4 py-3 text-right tabular-nums">
                                            {c.push_failed > 0 ? (
                                                <span className="text-rose-600">
                                                    {c.push_failed}
                                                </span>
                                            ) : (
                                                <span className="text-gray-400">0</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                                            {c.dispositions_received}
                                        </td>
                                        <td className="px-4 py-3 text-gray-500 text-xs">
                                            {fmtDate(c.created_at)}
                                            {c.created_by_name
                                                ? ` · ${c.created_by_name}`
                                                : ""}
                                        </td>
                                        <td className="px-4 py-3 text-right text-gray-400 group-hover:text-emerald-600">
                                            <ChevronRight className="w-4 h-4 inline-block" />
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {showCreate && (
                <NeodoveCampaignModal
                    onClose={() => setShowCreate(false)}
                    onCreated={(id) => {
                        setShowCreate(false);
                        void refetch();
                        // Straight to the detail page: a new campaign is a DRAFT
                        // with nothing pushed, and the next thing anyone wants is
                        // to preview the audience before sending it.
                        router.push(`/leads/neodove-campaigns/${id}`);
                    }}
                />
            )}
        </div>
    );
}
