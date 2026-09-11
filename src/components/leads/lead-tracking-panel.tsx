"use client";

/**
 * "Lead tracking" — the lead's journey in one place (E-295).
 *
 * Current state (status, holder, time in each), then the JOURNEY: one node per
 * ownership episode — who held the lead, from when, for how long, who handed
 * it over and why, what they did while holding it — and every action under
 * the episode it happened in. One component, mounted in three places: the
 * /leads drawer, the full /leads/[id] page, and the inside-sales / ASM lead
 * detail tab. The data comes from GET /api/dealer-leads/[id]/tracking, which
 * also enforces who may see whose leads; a 403 here renders as a sentence,
 * not as a broken panel.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
    AlertTriangle,
    ChevronDown,
    ChevronRight,
    Download,
    Loader2,
    Route,
    UserRound,
} from "lucide-react";
import { StatusChip } from "@/app/(dashboard)/inside-sales/_components/StatusChip";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import { humanise } from "@/lib/lifecycle/touchpointLabels";
import {
    fmtDuration,
    prettyRole,
    type LeadTracking,
    type OwnershipEpisode,
    type TrackingEvent,
    type TrackingPerson,
} from "@/lib/leads/trackingTypes";

type Props = {
    leadId: string;
    /** Whether to offer the CSV download (the endpoint enforces it too). */
    canDownload: boolean;
    /** Tighter spacing for the 440px drawer. */
    compact?: boolean;
};

type ApiResult =
    | { success: true; data: LeadTracking }
    | { success: false; error?: { message?: string } };

const PAGE = 8;

function fmtDateTime(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "—";
    }
}

const statusText = (v: string | null) => (v ? humanise(v, LEAD_STATUS_LABEL) : "—");

function RoleChip({ person }: { person: TrackingPerson }) {
    if (!person.role) return null;
    return (
        <span className="ml-1.5 inline-flex items-center rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
            {prettyRole(person.role)}
        </span>
    );
}

function PersonName({ person }: { person: TrackingPerson }) {
    const muted = person.id == null;
    return (
        <span className={muted ? "text-gray-500 italic" : "font-medium text-gray-900"}>
            {person.name}
            {!muted && <RoleChip person={person} />}
        </span>
    );
}

export function LeadTrackingPanel({ leadId, canDownload, compact = false }: Props) {
    const [downloading, setDownloading] = useState(false);
    const [openSeq, setOpenSeq] = useState<Set<number>>(new Set());
    const [shown, setShown] = useState(PAGE);

    const q = useQuery<{ status: number; body: ApiResult }>({
        queryKey: ["lead-tracking", leadId],
        queryFn: async () => {
            const res = await fetch(
                `/api/dealer-leads/${encodeURIComponent(leadId)}/tracking`,
                { cache: "no-store" },
            );
            let body: ApiResult;
            try {
                body = (await res.json()) as ApiResult;
            } catch {
                body = { success: false, error: { message: "Could not load tracking." } };
            }
            return { status: res.status, body };
        },
        staleTime: 30 * 1000,
    });

    async function download() {
        setDownloading(true);
        try {
            const res = await fetch(
                `/api/dealer-leads/${encodeURIComponent(leadId)}/tracking?format=csv`,
                { cache: "no-store" },
            );
            if (!res.ok) {
                let message = "Download failed";
                try {
                    const json = await res.json();
                    message = json?.error?.message ?? message;
                } catch {
                    /* non-JSON body */
                }
                throw new Error(message);
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `lead-tracking-${leadId}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Lead tracking CSV downloaded.");
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setDownloading(false);
        }
    }

    const pad = compact ? "px-5" : "px-6";
    const header = (
        <div className={`flex items-start justify-between gap-3 ${compact ? "" : "mb-3"}`}>
            <div>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                    <Route className="h-3.5 w-3.5 text-gray-500" />
                    Lead tracking
                </h3>
                <p className="mt-0.5 text-[11px] text-gray-500">
                    Where the lead has travelled, who held it for how long, and what they did.
                </p>
            </div>
            {canDownload && (
                <button
                    type="button"
                    onClick={download}
                    disabled={downloading || !q.data || q.data.status !== 200}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                    title="Download this lead's journey as a CSV"
                >
                    {downloading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Download className="h-3.5 w-3.5" />
                    )}
                    Download CSV
                </button>
            )}
        </div>
    );

    if (q.isLoading) {
        return (
            <div className={`${pad} py-4`}>
                {header}
                <div className="flex items-center gap-2 py-6 text-[12px] text-gray-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading journey…
                </div>
            </div>
        );
    }

    if (!q.data || q.data.status !== 200 || !q.data.body.success) {
        const msg =
            q.data?.status === 403
                ? "You can only track leads you have handled."
                : (q.data?.body && !q.data.body.success && q.data.body.error?.message) ||
                  "Could not load lead tracking.";
        return (
            <div className={`${pad} py-4`}>
                {header}
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    {msg}
                </div>
            </div>
        );
    }

    const t = q.data.body.data;
    const L = t.lead;
    const eventsByEpisode = new Map<number, TrackingEvent[]>();
    for (const ev of t.events) {
        const list = eventsByEpisode.get(ev.episode_seq) ?? [];
        list.push(ev);
        eventsByEpisode.set(ev.episode_seq, list);
    }
    // Journey reads oldest → newest; the live hold is last and highlighted.
    const episodes = t.episodes;
    const live = episodes[episodes.length - 1];
    // Actions list reads newest first, like the activity timeline.
    const recent = [...t.events].reverse();

    const toggle = (seq: number) =>
        setOpenSeq((s) => {
            const n = new Set(s);
            if (n.has(seq)) n.delete(seq);
            else n.add(seq);
            return n;
        });

    return (
        <div className={`${pad} py-4`}>
            {header}

            {/* ── Current state ── */}
            <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 text-[11px]">
                <dt className="text-gray-500">Current status</dt>
                <dd className="col-span-2 flex flex-wrap items-center gap-1.5">
                    <StatusChip status={L.lead_status as LeadStatus | null} size="sm" />
                    <span className="text-gray-500">
                        for {fmtDuration(L.time_in_status_sec)}
                    </span>
                </dd>

                <dt className="text-gray-500">Held by</dt>
                <dd className="col-span-2">
                    <PersonName person={L.current_owner} />
                    <span className="ml-1 text-gray-500">
                        for {fmtDuration(L.time_with_owner_sec)}
                    </span>
                </dd>

                {L.asm && (
                    <>
                        <dt className="text-gray-500">ASM</dt>
                        <dd className="col-span-2">
                            <PersonName person={L.asm} />
                        </dd>
                    </>
                )}

                <dt className="text-gray-500">Lead age</dt>
                <dd className="col-span-2 tabular-nums text-gray-800">
                    {fmtDuration(L.age_sec)}
                    <span className="ml-1 text-gray-500">
                        · created {fmtDateTime(L.created_at)}
                    </span>
                </dd>

                <dt className="text-gray-500">Hand-offs</dt>
                <dd className="col-span-2 tabular-nums text-gray-800">
                    {L.handoffs} · {t.events.length} action
                    {t.events.length === 1 ? "" : "s"} in total
                </dd>

                {L.closed_at && (
                    <>
                        <dt className="text-gray-500">Closed</dt>
                        <dd className="col-span-2 tabular-nums text-gray-800">
                            {fmtDateTime(L.closed_at)}
                        </dd>
                    </>
                )}
            </dl>

            {t.truncated && (
                <p className="mt-2 flex items-center gap-1 text-[11px] text-amber-700">
                    <AlertTriangle className="h-3 w-3" />
                    History is very long; the oldest actions were cut off.
                </p>
            )}

            {/* ── Journey ── */}
            <h4 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Journey
            </h4>
            <ol className="mt-2 space-y-0">
                {episodes.map((e) => {
                    const isLive = e === live;
                    const open = openSeq.has(e.seq);
                    const evs = eventsByEpisode.get(e.seq) ?? [];
                    return (
                        <li key={e.seq} className="relative pl-6">
                            {/* rail */}
                            {!isLive && (
                                <span className="absolute left-[7px] top-4 h-full w-px bg-gray-200" />
                            )}
                            <span
                                className={`absolute left-0 top-1.5 flex h-4 w-4 items-center justify-center rounded-full border ${
                                    isLive
                                        ? "border-emerald-500 bg-emerald-50"
                                        : "border-gray-300 bg-white"
                                }`}
                            >
                                <UserRound
                                    className={`h-2.5 w-2.5 ${isLive ? "text-emerald-600" : "text-gray-400"}`}
                                />
                            </span>

                            <button
                                type="button"
                                onClick={() => toggle(e.seq)}
                                className="flex w-full items-start justify-between gap-2 rounded-md py-1.5 pr-1 text-left transition hover:bg-gray-50"
                            >
                                <div className="min-w-0">
                                    <div className="text-[12px]">
                                        <PersonName person={e.holder} />
                                        {isLive && (
                                            <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                                                now
                                            </span>
                                        )}
                                        {e.approximate && (
                                            <span
                                                className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                                                title="Reconstructed from older records; the start time is best-effort."
                                            >
                                                approx.
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-0.5 text-[11px] tabular-nums text-gray-600">
                                        <span className="font-medium text-gray-800">
                                            {fmtDuration(e.duration_sec)}
                                        </span>{" "}
                                        · {fmtDateTime(e.from_at)} →{" "}
                                        {e.to_at ? fmtDateTime(e.to_at) : "now"}
                                    </div>
                                    {e.handed_by && (
                                        <div className="mt-0.5 text-[11px] text-gray-600">
                                            {e.handoff_label ?? "Handed over"} by{" "}
                                            <PersonName person={e.handed_by} />
                                            {e.handoff_reason && (
                                                <span className="text-gray-500">
                                                    {" "}
                                                    · {e.handoff_reason}
                                                </span>
                                            )}
                                        </div>
                                    )}
                                    <div className="mt-0.5 text-[11px] text-gray-500">
                                        {statusText(e.status_at_start)}
                                        {e.status_at_end !== e.status_at_start && (
                                            <> → {statusText(e.status_at_end)}</>
                                        )}
                                        {" · "}
                                        {e.actions_count} action
                                        {e.actions_count === 1 ? "" : "s"}
                                    </div>
                                </div>
                                {open ? (
                                    <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-gray-400" />
                                ) : (
                                    <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-gray-400" />
                                )}
                            </button>

                            {open && (
                                <ul className="mb-2 ml-1 space-y-1.5 border-l border-gray-100 pl-3">
                                    {evs.length === 0 && (
                                        <li className="text-[11px] text-gray-400">
                                            Nothing was done during this hold.
                                        </li>
                                    )}
                                    {evs.map((ev, i) => (
                                        <EventLine key={i} ev={ev} />
                                    ))}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ol>

            {/* ── All actions ── */}
            <h4 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                All actions · newest first
            </h4>
            {recent.length === 0 ? (
                <p className="mt-2 text-[11px] text-gray-400">No actions recorded yet.</p>
            ) : (
                <>
                    <ul className="mt-2 space-y-1.5">
                        {recent.slice(0, shown).map((ev, i) => (
                            <EventLine key={i} ev={ev} showHolder episodes={episodes} />
                        ))}
                    </ul>
                    {recent.length > shown && (
                        <button
                            type="button"
                            onClick={() => setShown((n) => n + PAGE)}
                            className="mt-2 text-[11px] font-semibold text-gray-600 underline underline-offset-2 hover:text-gray-900"
                        >
                            Show {Math.min(PAGE, recent.length - shown)} more
                        </button>
                    )}
                </>
            )}
        </div>
    );
}

function EventLine({
    ev,
    showHolder = false,
    episodes,
}: {
    ev: TrackingEvent;
    showHolder?: boolean;
    episodes?: OwnershipEpisode[];
}) {
    const holder = episodes?.[ev.episode_seq]?.holder;
    return (
        <li className="text-[11px]">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="tabular-nums text-gray-500">{fmtDateTime(ev.at)}</span>
                <PersonName person={ev.actor} />
                <span className="text-gray-700">{ev.action}</span>
                {ev.to_person && (
                    <span className="text-gray-600">
                        → <PersonName person={ev.to_person} />
                    </span>
                )}
                {ev.call_status && (
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                        {ev.call_status.replace(/_/g, " ")}
                        {ev.duration_sec != null ? ` · ${ev.duration_sec}s` : ""}
                    </span>
                )}
                {showHolder && holder && (
                    <span className="text-gray-400">while {holder.name} held it</span>
                )}
            </div>
            {ev.details && (
                <p className="mt-0.5 whitespace-pre-line text-gray-500">{ev.details}</p>
            )}
        </li>
    );
}
