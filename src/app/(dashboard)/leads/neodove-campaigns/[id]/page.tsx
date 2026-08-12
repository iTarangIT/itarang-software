// NeoDove campaign detail.
//
// Answers the two questions an integration you cannot query can't answer for
// itself: did every lead we meant to send actually arrive, and did every call
// they made actually come back?
//
// The drift panel is the important one. Because NeoDove has no read API, a
// dropped webhook is invisible — the only evidence is a touchpoint that had to
// be backfilled from a CSV export. A non-zero backfill count means live
// delivery is lossy and reconciliation is doing real work.

"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    AlertTriangle,
    ArrowLeft,
    CheckCircle,
    Info,
    Settings,
} from "lucide-react";
import { NeodovePushPanel } from "@/components/leads/neodove-push-panel";
import { NeodoveCampaignModal } from "@/components/leads/neodove-campaign-modal";

type Detail = {
    campaign: {
        id: string;
        name: string;
        neodove_campaign_name: string | null;
        status: string;
        push_endpoint_ref: string | null;
        /** The env var actually resolves on the server — not just "a ref is set". */
        is_wired?: boolean;
        /** Other campaigns pushing into the SAME NeoDove campaign via this ref. */
        endpoint_shared_with?: { id: string; name: string }[];
        // Passed straight back into the edit modal. Omitting it is not neutral:
        // the modal treats "every mirror field blank on an existing campaign" as
        // "this mirror was wrong, clear it", so a campaign edited from this page
        // would silently lose its recorded NeoDove settings.
        mirror_config?: unknown;
        total_pushed: number;
        push_failed: number;
        dispositions_received: number;
        started_at: string | null;
        created_at: string;
        created_by_name: string | null;
    };
    pushBreakdown: { push_status: string; count: string }[];
    dispositions: {
        call_status: string | null;
        sync_method: string | null;
        count: string;
    }[];
    // Server-derived so the cards cannot disagree with the sections below them.
    // Every one of these replaces a number the page used to compute or read
    // wrongly — see the comments on each card.
    audienceCount: number | null;
    delivered: number;
    pushAttempts: number;
    dispositionsBack: number;
    dialRequests: number;
    drift: { backfilled: number; live: number };
    recentErrors: {
        id: string;
        event_type: string | null;
        dealer_lead_id: string | null;
        http_status: number | null;
        error: string | null;
        attempts: number;
        created_at: string;
    }[];
    failedLeads: {
        dealer_lead_id: string;
        push_error: string | null;
        push_status: string;
        dealer_name: string | null;
        shop_name: string | null;
        phone: string | null;
        city: string | null;
    }[];
};

const PUSH_LABEL: Record<string, string> = {
    pending: "Queued",
    pushed: "Delivered to NeoDove",
    failed: "Failed to deliver",
    skipped_dedup: "Already in NeoDove",
    skipped_excluded: "Skipped (no valid mobile / excluded)",
};

export default function NeodoveCampaignDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = use(params);
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState(false);

    const { data, isLoading, isError, error } = useQuery<Detail>({
        queryKey: ["neodove-campaign", id],
        queryFn: async () => {
            const res = await fetch(`/api/neodove/campaigns/${id}`);
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Failed to load campaign");
            }
            return json.data;
        },
        refetchInterval: (q) =>
            q.state.data?.campaign?.status === "pushing" ? 4000 : false,
    });

    if (isLoading) {
        return <p className="p-8 text-sm text-gray-500">Loading campaign…</p>;
    }
    if (isError || !data) {
        return (
            <div className="p-8">
                <p className="text-sm text-rose-600">
                    {error instanceof Error ? error.message : "Failed to load."}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                    If this says a relation does not exist, migration E-224 has not
                    been applied to this database yet.
                </p>
            </div>
        );
    }

    const c = data.campaign;
    const driftTotal = data.drift.backfilled + data.drift.live;
    const driftPct =
        driftTotal > 0 ? Math.round((data.drift.backfilled / driftTotal) * 100) : 0;

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 min-h-screen bg-gray-50">
            {/* Back to the NeoDove list rather than /leads?tab=campaigns: this
                page is now reached from the NeoDove sidebar item, and sending
                someone to the mixed AI-dialer/NeoDove tab loses their place. */}
            <Link
                href="/leads/neodove-campaigns"
                className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
            >
                <ArrowLeft className="w-4 h-4" /> NeoDove campaigns
            </Link>

            <div className="mt-3 flex items-start justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                        {c.name}
                    </h1>
                    <p className="text-sm text-gray-500 mt-0.5">
                        NeoDove ·{" "}
                        {c.neodove_campaign_name ?? (
                            <span className="text-amber-600">
                                no NeoDove campaign name recorded
                            </span>
                        )}
                        {c.created_by_name ? ` · created by ${c.created_by_name}` : ""}
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={() => setEditing(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                        <Settings className="w-4 h-4" /> Settings
                    </button>
                    <span className="px-2.5 py-1 text-xs font-medium rounded-full bg-purple-50 text-purple-700">
                        {c.status}
                    </span>
                </div>
            </div>

            {!c.push_endpoint_ref && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex gap-2">
                    <Info className="w-4 h-4 mt-0.5 shrink-0" />
                    <div>
                        <p>
                            No push endpoint configured. This campaign cannot send
                            anything until it knows which environment variable holds its
                            NeoDove Custom Integration URL.
                        </p>
                        <button
                            onClick={() => setEditing(true)}
                            className="mt-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
                        >
                            Configure endpoint
                        </button>
                    </div>
                </div>
            )}

            {/* A ref IS set but the variable behind it is empty on this server.
                Distinct from the case above and far more dangerous: this campaign
                looked configured, and before is_wired became a real check it was
                offered as a destination in the Send-to-NeoDove dropdown. */}
            {c.push_endpoint_ref && c.is_wired === false && (
                <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 flex gap-2">
                    <Info className="w-4 h-4 mt-0.5 shrink-0" />
                    <div>
                        <p>
                            This campaign points at{" "}
                            <strong className="font-mono">{c.push_endpoint_ref}</strong>,
                            but that environment variable is not set on this server — so
                            nothing can be pushed here. Add it to the environment (the
                            value is NeoDove&apos;s Custom Integration URL) and restart,
                            or point the campaign at an endpoint that is configured.
                        </p>
                        <button
                            onClick={() => setEditing(true)}
                            className="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700"
                        >
                            Change endpoint
                        </button>
                    </div>
                </div>
            )}

            {/* Two campaigns, one endpoint = one destination. The push body
                carries no campaign identifier, so the URL alone decides where a
                lead lands. */}
            {(c.endpoint_shared_with?.length ?? 0) > 0 && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex gap-2">
                    <Info className="w-4 h-4 mt-0.5 shrink-0" />
                    <p>
                        This campaign shares its push endpoint with{" "}
                        {c.endpoint_shared_with?.map((o, i) => (
                            <span key={o.id}>
                                {i > 0 && ", "}
                                <strong>{o.name}</strong>
                            </span>
                        ))}
                        . Leads sent to any of them arrive in the{" "}
                        <strong>same</strong> NeoDove campaign — the endpoint URL is what
                        routes a lead, not the campaign chosen here. Give each one its
                        own Custom Integration endpoint to route them separately.
                    </p>
                </div>
            )}

            {editing && (
                <NeodoveCampaignModal
                    campaign={{
                        id: c.id,
                        name: c.name,
                        neodove_campaign_name: c.neodove_campaign_name,
                        push_endpoint_ref: c.push_endpoint_ref,
                        mirror_config: c.mirror_config,
                    }}
                    onClose={() => setEditing(false)}
                    onCreated={() => {
                        setEditing(false);
                        void queryClient.invalidateQueries({
                            queryKey: ["neodove-campaign", id],
                        });
                    }}
                />
            )}

            {/* is_wired, not "a ref is set": the push panel must refuse a
                campaign whose env var is missing, which is the failure the
                banner above now names. Falls back to the old test only when the
                server did not send the flag (a stale cached bundle). */}
            <NeodovePushPanel
                campaignId={c.id}
                isWired={c.is_wired ?? Boolean(c.push_endpoint_ref)}
            />

            {/* STATS
                Every card here reads a server-derived number rather than a
                counter on the campaign row. The counters count ATTEMPTS and are
                incremented by name-matching against NeoDove, so they disagreed
                with the very sections below them on this same screen. */}
            <div className="mt-6 grid grid-cols-4 gap-3">
                <Stat
                    label="Audience"
                    value={data.audienceCount}
                    hint="Leads this campaign's filter targets right now"
                />
                <Stat
                    label="Delivered"
                    value={data.delivered}
                    tone="text-emerald-600"
                    hint={
                        data.pushAttempts !== data.delivered
                            ? `${data.pushAttempts} push attempts · ${data.delivered} distinct leads`
                            : undefined
                    }
                />
                <Stat
                    label="Failed to deliver"
                    value={c.push_failed}
                    tone={c.push_failed > 0 ? "text-rose-600" : "text-gray-900"}
                />
                <Stat
                    label="Dispositions back"
                    value={data.dispositionsBack}
                    tone="text-blue-600"
                    hint={
                        data.dialRequests > 0
                            ? `${data.dialRequests} priority-dial hand-off${data.dialRequests === 1 ? "" : "s"} requested`
                            : undefined
                    }
                />
            </div>

            {/* DRIFT */}
            <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="text-sm font-semibold text-gray-900">
                    Webhook delivery health
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                    NeoDove has no read API, so anything its webhook fails to deliver is
                    only recoverable by importing their CSV export. Backfilled rows are
                    the ones that arrived that way.
                </p>
                {driftTotal === 0 ? (
                    <p className="mt-3 text-sm text-gray-500">
                        No dispositions recorded for this campaign yet.
                    </p>
                ) : (
                    <div className="mt-3 flex items-center gap-6">
                        <div className="flex items-center gap-2">
                            {data.drift.backfilled === 0 ? (
                                <CheckCircle className="w-4 h-4 text-emerald-600" />
                            ) : (
                                <AlertTriangle className="w-4 h-4 text-amber-600" />
                            )}
                            <span className="text-sm text-gray-800">
                                {data.drift.live} live · {data.drift.backfilled} backfilled
                            </span>
                        </div>
                        <span
                            className={`text-sm font-medium ${
                                driftPct === 0
                                    ? "text-emerald-600"
                                    : driftPct < 10
                                      ? "text-amber-600"
                                      : "text-rose-600"
                            }`}
                        >
                            {driftPct}% drift
                        </span>
                    </div>
                )}
            </section>

            {/* PUSH BREAKDOWN */}
            <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="text-sm font-semibold text-gray-900">Push results</h2>
                <div className="mt-3 space-y-2">
                    {data.pushBreakdown.length === 0 && (
                        <p className="text-sm text-gray-500">Nothing pushed yet.</p>
                    )}
                    {data.pushBreakdown.map((r) => (
                        <div
                            key={r.push_status}
                            className="flex items-center justify-between text-sm"
                        >
                            <span className="text-gray-700">
                                {PUSH_LABEL[r.push_status] ?? r.push_status}
                            </span>
                            <span className="tabular-nums font-medium text-gray-900">
                                {r.count}
                            </span>
                        </div>
                    ))}
                </div>
            </section>

            {/* DISPOSITIONS */}
            {data.dispositions.length > 0 && (
                <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="text-sm font-semibold text-gray-900">
                        Call outcomes
                    </h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                        Calls NeoDove reported back. Priority-dial hand-offs are
                        counted separately — asking the calling team to ring
                        someone is not a call outcome.
                    </p>
                    <div className="mt-3 space-y-2">
                        {data.dispositions.map((d, i) => (
                            <div
                                key={`${d.call_status}-${d.sync_method}-${i}`}
                                className="flex items-center justify-between text-sm"
                            >
                                <span className="text-gray-700">
                                    {d.call_status ?? "unclassified"}
                                    {d.sync_method === "reconciliation" && (
                                        <span className="ml-2 text-[11px] text-amber-600">
                                            backfilled
                                        </span>
                                    )}
                                </span>
                                <span className="tabular-nums font-medium text-gray-900">
                                    {d.count}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* FAILED LEADS */}
            {data.failedLeads.length > 0 && (
                <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="text-sm font-semibold text-gray-900">
                        Leads that did not reach NeoDove
                    </h2>
                    <table className="mt-3 w-full text-sm">
                        <tbody>
                            {data.failedLeads.map((l) => (
                                <tr key={l.dealer_lead_id} className="border-t border-gray-100">
                                    <td className="py-2 pr-3">
                                        <span className="font-medium text-gray-900">
                                            {l.dealer_name ?? l.shop_name ?? l.dealer_lead_id}
                                        </span>
                                        <span className="text-gray-400 ml-2">{l.phone}</span>
                                    </td>
                                    <td className="py-2 text-xs text-rose-600">
                                        {l.push_error ?? l.push_status}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}

            {/* ERRORS */}
            {data.recentErrors.length > 0 && (
                <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="text-sm font-semibold text-gray-900">
                        Recent sync errors
                    </h2>
                    <div className="mt-3 space-y-2">
                        {data.recentErrors.map((e) => (
                            <div key={e.id} className="text-xs border-t border-gray-100 pt-2">
                                <span className="text-gray-500">
                                    {new Date(e.created_at).toLocaleString("en-IN")} ·{" "}
                                    {e.event_type ?? "—"}
                                    {e.http_status ? ` · HTTP ${e.http_status}` : ""}
                                    {e.attempts ? ` · ${e.attempts} attempts` : ""}
                                </span>
                                <p className="text-rose-600 mt-0.5">{e.error}</p>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function Stat({
    label,
    value,
    tone = "text-gray-900",
    hint,
}: {
    label: string;
    // Nullable: the audience count is resolved best-effort, and an em dash is
    // honest where a 0 would read as "this campaign targets nobody".
    value: number | null;
    tone?: string;
    hint?: string;
}) {
    return (
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs text-gray-500">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${tone}`}>
                {value ?? "—"}
            </p>
            {hint && <p className="mt-0.5 text-[11px] text-gray-400">{hint}</p>}
        </div>
    );
}
