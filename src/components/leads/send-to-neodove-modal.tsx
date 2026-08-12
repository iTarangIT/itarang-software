// Hand leads to a NeoDove campaign — one row, or a ticked selection.
//
// WHY A MODAL AND NOT A ONE-CLICK BUTTON. The push is irreversible and consumes
// NeoDove plan quota (they bill by lead slots, not by call), and the target
// campaign is not inferable — a lead can go to any wired campaign. So the
// operator picks the destination and confirms.
//
// WHY TWO ENDPOINTS. A single lead goes to leads/[id]/push, which is
// synchronous and returns a real answer. A selection goes to push-batch, which
// acks and drains in the background because pacing 500 leads at 250ms outlives
// any request timeout. Same guarantees either way — the difference the operator
// sees is "sent" versus "queued", and that difference is true.
//
// WHY THE ERROR HANDLING IS THE BULK OF THIS FILE. The push routes have three
// distinct 409s and each needs a different remedy: wire an endpoint, enable the
// integration, or consciously override the "someone is already working this
// lead" guard. A single red toast would leave the operator stuck on all three.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X, Send, AlertTriangle, ExternalLink } from "lucide-react";

type Campaign = {
    id: string;
    name: string;
    neodove_campaign_name: string | null;
    status: string;
    /** The endpoint env var actually resolves on the server — not merely "a ref
     *  is recorded", which is what this used to mean and why a campaign with a
     *  missing variable was offered here and then failed at push time. */
    is_wired: boolean;
    /** Other campaigns pushing through the same endpoint, i.e. the same
     *  destination in NeoDove. */
    endpoint_shared_with?: string[];
};

type BatchResult = {
    selected: number;
    eligible: number;
    queued: number;
    alreadyLinked: number;
    skipped: { notFound: number; noPhone: number; activelyWorked: number };
};

/**
 * The routes signal "these leads are actively being worked" by telling the
 * caller to retry with force. Matching that instruction is the only
 * machine-readable discriminator the API offers — every other failure renders
 * its message verbatim, which is already actionable, so an unmatched message
 * degrades to plain text rather than to a dead end.
 */
function isActivelyWorkedError(message: string): boolean {
    return message.includes("force");
}

function isEndpointError(message: string): boolean {
    return message.includes("push endpoint");
}

/**
 * One readable line per campaign.
 *
 * The two names are usually the same thing said twice — a CRM row called
 * `CRM_NEODOVE_1` pointing at a NeoDove campaign called `CRM_NEODOVE_1 (DEMO)`
 * rendered as "CRM_NEODOVE_1 → CRM_NEODOVE_1 (DEMO)", which is noise that
 * pushes the meaningful part off the end of a narrow select. So the arrow form
 * is kept ONLY when the names genuinely differ, which is the case that matters:
 * `Rushikesh_Demo_1 → Custom_Rushikesh_Demo` is worth spelling out, because
 * without it nobody could tell where that lead is about to land.
 */
function campaignLabel(c: Campaign): string {
    const target = c.neodove_campaign_name?.trim();
    if (!target) return c.name;
    // Same name plus a suffix like " (DEMO)" — show the NeoDove one alone, since
    // that is the name the operator will look for in NeoDove's own UI.
    if (target.toLowerCase().startsWith(c.name.trim().toLowerCase())) return target;
    return `${c.name} → ${target}`;
}

export function SendToNeodoveModal({
    leadIds,
    label,
    onClose,
    onSent,
}: {
    leadIds: string[];
    /** What the operator is sending, e.g. a dealer name or "12 leads". */
    label: string;
    onClose: () => void;
    onSent?: () => void;
}) {
    const isBatch = leadIds.length > 1;

    const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
    const [campaignId, setCampaignId] = useState("");
    const [force, setForce] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [batch, setBatch] = useState<BatchResult | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/neodove/campaigns")
            .then((r) => r.json())
            .then((json) => {
                if (cancelled) return;
                const rows: Campaign[] = Array.isArray(json?.data) ? json.data : [];
                setCampaigns(rows);
                // Preselect the only usable destination, if there is exactly one.
                const wired = rows.filter((c) => c.is_wired);
                if (wired.length === 1) setCampaignId(wired[0].id);
            })
            .catch(() => {
                if (!cancelled) setCampaigns([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Ticking "hand over anyway" is a fresh decision about a request that has
    // already been refused once; leaving the old refusal on screen reads as if
    // the checkbox did nothing.
    useEffect(() => {
        if (force) setError(null);
    }, [force]);

    const selected = campaigns?.find((c) => c.id === campaignId) ?? null;
    // Alphabetical, not the API's created_at DESC. This is a picker, not a
    // feed: the operator is looking for a name they already have in mind, and
    // newest-first meant the most recently touched campaign — often a legacy
    // one that was just edited — sat above the ones actually in use.
    const wiredCampaigns = (campaigns ?? [])
        .filter((c) => c.is_wired)
        .sort((a, b) => campaignLabel(a).localeCompare(campaignLabel(b)));
    const unwiredCount = (campaigns?.length ?? 0) - wiredCampaigns.length;
    const targetName = selected?.neodove_campaign_name ?? selected?.name ?? "the target";

    async function send() {
        if (!campaignId || sending) return;
        setSending(true);
        setError(null);
        try {
            const res = await fetch(
                isBatch
                    ? "/api/neodove/leads/push-batch"
                    : `/api/neodove/leads/${leadIds[0]}/push`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        campaignId,
                        ...(isBatch ? { leadIds } : {}),
                        ...(force ? { force: true } : {}),
                    }),
                },
            );
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Push failed");
            }
            if (isBatch) setBatch(json.data as BatchResult);
            setDone(true);
            onSent?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Push failed");
            setSending(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            {/* max-w-lg, not md: campaign labels run to ~40 characters
                ("Rushikesh_Demo_1 → Custom_Rushikesh_Demo") and were being
                truncated by the select at the narrower width. max-h + scroll so
                a long error plus the batch breakdown cannot push the footer
                buttons off a short viewport. */}
            <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
                <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-6 py-4">
                    <h2 className="text-base font-semibold text-gray-900">
                        Send to NeoDove
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600"
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {done ? (
                    <div className="flex-1 overflow-y-auto px-6 py-6 space-y-3">
                        {batch ? (
                            <>
                                <p className="text-sm text-gray-900">
                                    <strong>{batch.queued}</strong> of {batch.selected}{" "}
                                    selected leads queued for{" "}
                                    <strong>{targetName}</strong>.
                                </p>
                                <ul className="space-y-1 text-xs text-gray-600">
                                    {batch.alreadyLinked > 0 && (
                                        <li>
                                            {batch.alreadyLinked} were already sent to this
                                            campaign earlier — not re-sent, so no quota was
                                            spent twice.
                                        </li>
                                    )}
                                    {batch.skipped.activelyWorked > 0 && (
                                        <li>
                                            {batch.skipped.activelyWorked} skipped — someone
                                            is already working them.
                                        </li>
                                    )}
                                    {batch.skipped.noPhone > 0 && (
                                        <li>
                                            {batch.skipped.noPhone} skipped — no valid Indian
                                            mobile.
                                        </li>
                                    )}
                                    {batch.skipped.notFound > 0 && (
                                        <li>
                                            {batch.skipped.notFound} skipped — no longer in
                                            the database.
                                        </li>
                                    )}
                                </ul>
                                <Link
                                    href="/leads/neodove-campaigns/activity"
                                    className="inline-flex items-center gap-1 text-xs font-medium text-gray-900 underline"
                                >
                                    Watch progress in Sync Activity
                                    <ExternalLink className="w-3 h-3" />
                                </Link>
                            </>
                        ) : (
                            <p className="text-sm text-gray-900">
                                <strong>{label}</strong> was accepted by NeoDove.
                            </p>
                        )}

                        {/* The single most important caveat in this integration.
                            A 200 from NeoDove's Custom Integration endpoint means
                            "accepted", not "created" — a push with a placeholder
                            mobile returned 200 and created nothing. */}
                        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            NeoDove returns the same response whether or not a lead was
                            actually created — it sends no lead id back. Confirm the
                            leads appear in <strong>{targetName}</strong> in NeoDove
                            before treating them as delivered.
                        </p>
                        <div className="flex justify-end">
                            <button
                                onClick={onClose}
                                className="rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
                            <p className="text-sm text-gray-600">
                                Hand <strong className="text-gray-900">{label}</strong> to
                                the NeoDove calling team.
                            </p>

                            <div>
                                <label className="block text-sm font-medium text-gray-700">
                                    Destination campaign
                                </label>
                                {campaigns === null ? (
                                    <p className="mt-1.5 text-sm text-gray-400">
                                        Loading campaigns…
                                    </p>
                                ) : wiredCampaigns.length === 0 ? (
                                    <div className="mt-1.5 rounded-lg bg-amber-50 px-3 py-2.5">
                                        <p className="text-xs text-amber-800">
                                            No campaign has a push endpoint configured, so
                                            there is nowhere to send these leads yet.
                                        </p>
                                        <Link
                                            href="/leads/neodove-campaigns"
                                            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-amber-900 underline"
                                        >
                                            Configure a campaign
                                            <ExternalLink className="w-3 h-3" />
                                        </Link>
                                    </div>
                                ) : (
                                    <>
                                        <select
                                            value={campaignId}
                                            onChange={(e) => setCampaignId(e.target.value)}
                                            className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                                        >
                                            <option value="">Select a campaign…</option>
                                            {wiredCampaigns.map((c) => (
                                                <option key={c.id} value={c.id}>
                                                    {campaignLabel(c)}
                                                </option>
                                            ))}
                                        </select>
                                        {unwiredCount > 0 && (
                                            <p className="mt-1 text-xs text-gray-500">
                                                {unwiredCount} campaign
                                                {unwiredCount === 1 ? " is" : "s are"} hidden
                                                — no working push endpoint configured.
                                            </p>
                                        )}
                                        {/* THE MIS-ROUTING WARNING. The push body
                                            carries no campaign identifier — the
                                            endpoint URL alone decides where a lead
                                            lands — so two campaigns sharing an
                                            endpoint are one destination wearing two
                                            names. Without this, picking between them
                                            reads as a routing decision that silently
                                            does nothing. */}
                                        {(selected?.endpoint_shared_with?.length ?? 0) >
                                            0 && (
                                            <p className="mt-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                                                <strong>{selected?.name}</strong> shares its
                                                NeoDove endpoint with{" "}
                                                {selected?.endpoint_shared_with?.join(", ")}.
                                                These leads land in the same NeoDove
                                                campaign whichever of them you pick.
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>

                            {isBatch && (
                                <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                                    Leads someone is already working are skipped
                                    automatically, and leads already sent to this campaign
                                    are not re-sent. You will see the exact breakdown after
                                    sending.
                                </p>
                            )}

                            {error && (
                                <div className="rounded-lg bg-rose-50 px-3 py-2.5 space-y-2">
                                    <p className="flex items-start gap-2 text-sm text-rose-700">
                                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                        <span>{error}</span>
                                    </p>

                                    {isActivelyWorkedError(error) && (
                                        <label className="flex items-start gap-2 text-xs text-rose-800">
                                            <input
                                                type="checkbox"
                                                checked={force}
                                                onChange={(e) => setForce(e.target.checked)}
                                                className="mt-0.5"
                                            />
                                            <span>
                                                Hand over anyway. NeoDove will call leads
                                                someone is already working — both teams may
                                                contact the same dealer.
                                            </span>
                                        </label>
                                    )}

                                    {isEndpointError(error) && campaignId && (
                                        <Link
                                            href={`/leads/neodove-campaigns/${campaignId}`}
                                            className="inline-flex items-center gap-1 text-xs font-medium text-rose-900 underline"
                                        >
                                            Open campaign settings
                                            <ExternalLink className="w-3 h-3" />
                                        </Link>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="flex shrink-0 justify-end gap-2 border-t border-gray-100 px-6 py-4">
                            <button
                                onClick={onClose}
                                className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={send}
                                disabled={!campaignId || sending}
                                className="flex items-center gap-2 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                            >
                                <Send className="w-3.5 h-3.5" />
                                {sending
                                    ? "Sending…"
                                    : force
                                      ? "Hand over anyway"
                                      : isBatch
                                        ? `Send ${leadIds.length} leads`
                                        : "Send lead"}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
