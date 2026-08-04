// Preview + push for a NeoDove campaign (E-224).
//
// PREVIEW BEFORE PUSH IS NOT POLITENESS. A push consumes the NeoDove plan's
// lead quota (50,000 on this account) and cannot be undone from our side —
// there is no delete API, so a mistaken push of 5,000 leads is 5,000 slots gone
// and a manual cleanup in their UI. The count is therefore shown, and confirmed,
// before anything is sent.
//
// The audience is re-resolved SERVER-side at push time and the id list here is
// never sent back — a stale tab must not be able to push leads the operator
// never saw. That means the previewed number and the pushed number can differ
// slightly if leads changed status in between, which is the correct trade.

"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Send, Users } from "lucide-react";

type Preview = {
    counts: { hot: number; warm: number; cold: number; all: number };
    excluded: { total: number; byReason: Record<string, number> };
    totalWithPhone: number;
    total: number;
    sample: {
        id: string;
        phone: string | null;
        dealer_name: string | null;
        shop_name: string | null;
    }[];
};

type PushResult = {
    campaignId: string;
    audienceResolved: number;
    queued: number;
    excluded: { total: number; byReason: Record<string, number> };
    status: string;
};

export function NeodovePushPanel({
    campaignId,
    isWired,
}: {
    campaignId: string;
    isWired: boolean;
}) {
    const queryClient = useQueryClient();
    const [preview, setPreview] = useState<Preview | null>(null);
    const [loading, setLoading] = useState(false);
    const [pushing, setPushing] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [result, setResult] = useState<PushResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function loadPreview() {
        setLoading(true);
        setError(null);
        setResult(null);
        try {
            const res = await fetch(
                `/api/neodove/campaigns/${campaignId}/preview`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    // Empty body → the route falls back to the campaign's stored
                    // audience_filter, which is what we want here.
                    body: "{}",
                },
            );
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Preview failed");
            }
            setPreview(json.data);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Preview failed");
        } finally {
            setLoading(false);
        }
    }

    async function push() {
        setPushing(true);
        setError(null);
        try {
            const res = await fetch(`/api/neodove/campaigns/${campaignId}/push`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Push failed");
            }
            setResult(json.data);
            setConfirming(false);
            // The drain runs in after(); counters move for a while yet. The
            // detail page polls while status === 'pushing'.
            void queryClient.invalidateQueries({
                queryKey: ["neodove-campaign", campaignId],
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Push failed");
            setConfirming(false);
        } finally {
            setPushing(false);
        }
    }

    return (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-sm font-semibold text-gray-900">
                        Send leads to NeoDove
                    </h2>
                    <p className="mt-0.5 text-xs text-gray-500">
                        Check the audience, then push. Re-pushing only picks up leads
                        that are new to this campaign.
                    </p>
                </div>
                <div className="flex gap-2 shrink-0">
                    <button
                        onClick={loadPreview}
                        disabled={loading}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                        {loading ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Users className="w-4 h-4" />
                        )}
                        Preview audience
                    </button>
                    <button
                        onClick={() => setConfirming(true)}
                        disabled={!isWired || pushing || !preview}
                        title={
                            !isWired
                                ? "This campaign has no push endpoint configured"
                                : !preview
                                  ? "Preview the audience first"
                                  : undefined
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                    >
                        <Send className="w-4 h-4" /> Push
                    </button>
                </div>
            </div>

            {error && (
                <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                    {error}
                </p>
            )}

            {preview && (
                <div className="mt-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <Cell label="Will be sent" value={preview.total} strong />
                        <Cell label="Hot" value={preview.counts.hot} />
                        <Cell label="Warm" value={preview.counts.warm} />
                        <Cell label="Cold" value={preview.counts.cold} />
                    </div>

                    {preview.excluded.total > 0 && (
                        <p className="mt-3 text-xs text-gray-500">
                            {preview.excluded.total} lead
                            {preview.excluded.total === 1 ? "" : "s"} excluded —{" "}
                            {Object.entries(preview.excluded.byReason)
                                .filter(([, n]) => n > 0)
                                .map(([reason, n]) => `${n} ${reason.replace(/_/g, " ")}`)
                                .join(", ") || "none"}
                            . Converted, not-interested, DNC and blacklisted leads are
                            never sent.
                        </p>
                    )}

                    {preview.sample.length > 0 && (
                        <div className="mt-3">
                            <p className="text-xs font-medium text-gray-600">
                                First {preview.sample.length} of {preview.total}
                            </p>
                            <ul className="mt-1.5 space-y-1">
                                {preview.sample.slice(0, 5).map((s) => (
                                    <li key={s.id} className="text-xs text-gray-600">
                                        {s.dealer_name || s.shop_name || "—"}
                                        <span className="text-gray-400">
                                            {" "}
                                            · {s.phone ?? "no phone"}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {confirming && preview && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-900 flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4" />
                        Push {preview.total} lead{preview.total === 1 ? "" : "s"} to
                        NeoDove?
                    </p>
                    <p className="mt-1 text-xs text-amber-800">
                        This consumes {preview.total} of the NeoDove plan&apos;s lead
                        quota and cannot be undone from here — NeoDove has no delete
                        API, so removing them means doing it by hand in their UI.
                    </p>
                    <div className="mt-3 flex gap-2">
                        <button
                            onClick={push}
                            disabled={pushing}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                        >
                            {pushing && <Loader2 className="w-4 h-4 animate-spin" />}
                            Yes, push
                        </button>
                        <button
                            onClick={() => setConfirming(false)}
                            className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {result && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                    <p className="text-sm text-emerald-900">
                        Queued {result.queued} lead
                        {result.queued === 1 ? "" : "s"} from an audience of{" "}
                        {result.audienceResolved}. Delivery runs in the background —
                        the counters above update as it progresses.
                    </p>
                    {/* The single most important caveat in this integration, put
                        where someone reads it at the moment it matters. */}
                    <p className="mt-1.5 text-xs text-emerald-800">
                        &ldquo;Delivered&rdquo; means NeoDove accepted the request, not
                        that the lead exists on their side — their endpoint returns 200
                        even for payloads it discards. Confirm in NeoDove, or reconcile
                        against a CSV export.
                    </p>
                </div>
            )}

            {!isWired && (
                <p className="mt-4 text-xs text-amber-700">
                    Pushing is disabled until this campaign has a push endpoint
                    configured.
                </p>
            )}
        </div>
    );
}

function Cell({
    label,
    value,
    strong,
}: {
    label: string;
    value: number;
    strong?: boolean;
}) {
    return (
        <div className="rounded-lg border border-gray-200 px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
                {label}
            </p>
            <p
                className={`mt-0.5 tabular-nums ${
                    strong
                        ? "text-xl font-bold text-gray-900"
                        : "text-base font-semibold text-gray-700"
                }`}
            >
                {value}
            </p>
        </div>
    );
}
