// Touchpoint timeline for the CRM lead-detail page.
//
// WHY THIS EXISTS AT ALL. /leads/[id] built its history exclusively from
// ai_call_logs, so it showed AI-dialer calls and nothing else. Every human
// touch — an inside-sales call, a WhatsApp message, and now every NeoDove
// disposition arriving on the webhook — was written to lead_touchpoints and
// then never rendered anywhere a CRM user looks. The integration could be
// working perfectly and still appear dead.
//
// WHY IT IS NOT TouchpointHistoryPane. That component is the left column of the
// inside-sales two-pane workspace: it is a sticky, scrolling, right-bordered
// column with an inside-sales Excel export in its header. Dropping it into a
// stacked card page would drag that layout and that route coupling along. The
// parts genuinely worth sharing — the icon and label maps — now live in
// lib/lifecycle/touchpointDisplay and are imported by both, so the two can
// never disagree about what a touchpoint type is called.

"use client";

import { useState } from "react";
import {
    TOUCHPOINT_ICONS,
    TOUCHPOINT_TYPE_LABEL,
    touchpointSourceLabel,
} from "@/lib/lifecycle/touchpointDisplay";
import type { TouchpointType } from "@/lib/lifecycle/touchpointTypes";
import {
    DISPOSITION_BUCKET_TONE,
    DISPOSITION_NEUTRAL_TONE,
    isDispositionBucket,
} from "@/lib/leads/dispositions";

export type LeadTouchpoint = {
    touchpoint_id: string;
    touchpoint_type: TouchpointType;
    performed_by_name: string | null;
    performed_at: string;
    call_status: string | null;
    call_duration_sec: number | null;
    is_engaged: boolean | null;
    remarks: string | null;
    external_system: string | null;
    sync_method: string | null;
    // E-226. Both null on every touchpoint until a NeoDove webhook carrying
    // them arrives — and null forever on manual ones, which is why neither is
    // rendered as an empty slot.
    recording_url?: string | null;
    external_agent_name?: string | null;
    // E-236. The classified disposition for THIS call, as opposed to the
    // lead's latest. Same optionality, same reason.
    disposition?: string | null;
    disposition_bucket?: string | null;
    connect_status?: string | null;
};

const PAGE = 8;

function formatTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatDuration(sec: number): string {
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function TouchpointTimeline({
    touchpoints,
}: {
    touchpoints: LeadTouchpoint[];
}) {
    const [shown, setShown] = useState(PAGE);
    const visible = touchpoints.slice(0, shown);

    // Backfilled rows mean webhooks were lost and had to be recovered from a
    // CSV. Surfacing the count here, not just on the campaign page, is what
    // makes silent delivery loss visible to the person reading the lead.
    const backfilled = touchpoints.filter(
        (t) => t.sync_method === "reconciliation",
    ).length;

    return (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-semibold text-gray-900">
                    Activity timeline
                </h2>
                <p className="text-xs text-gray-500">
                    {touchpoints.length}{" "}
                    {touchpoints.length === 1 ? "entry" : "entries"} · newest first
                    {backfilled > 0 && (
                        <span className="text-amber-700">
                            {" "}
                            · {backfilled} backfilled from CSV
                        </span>
                    )}
                </p>
            </div>

            {touchpoints.length === 0 ? (
                <p className="text-sm text-gray-500 py-8 text-center">
                    No touchpoints logged for this lead yet. Calls handled by NeoDove
                    or Inside Sales will appear here.
                </p>
            ) : (
                <>
                    <ol className="mt-4 space-y-3">
                        {visible.map((t) => {
                            const Icon =
                                TOUCHPOINT_ICONS[t.touchpoint_type] ??
                                TOUCHPOINT_ICONS.default;
                            const source = touchpointSourceLabel(
                                t.external_system,
                                t.sync_method,
                            );
                            return (
                                <li key={t.touchpoint_id} className="flex gap-3">
                                    <div className="shrink-0 mt-0.5">
                                        <div
                                            className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                                                t.is_engaged
                                                    ? "bg-emerald-50 text-emerald-600"
                                                    : "bg-gray-100 text-gray-500"
                                            }`}
                                        >
                                            <Icon className="h-4 w-4" />
                                        </div>
                                    </div>
                                    <div className="flex-1 min-w-0 rounded-lg border border-gray-100 bg-gray-50/40 px-3 py-2">
                                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                                            <div className="text-sm font-medium text-gray-900">
                                                {TOUCHPOINT_TYPE_LABEL[t.touchpoint_type] ??
                                                    t.touchpoint_type}
                                                {t.call_status && (
                                                    <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">
                                                        · {t.call_status.replace(/_/g, " ")}
                                                    </span>
                                                )}
                                                {t.is_engaged && (
                                                    <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                                                        engaged
                                                    </span>
                                                )}
                                                {source && (
                                                    <span
                                                        className={`ml-2 text-[10px] px-1.5 py-0.5 rounded border ${source.cls}`}
                                                    >
                                                        {source.label}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-[11px] text-gray-500 tabular-nums">
                                                {formatTime(t.performed_at)}
                                            </div>
                                        </div>
                                        {/* performed_by_name is one of OUR users;
                                            external_agent_name is the vendor's
                                            telecaller, who has no users row here.
                                            Labelled differently because attributing
                                            a NeoDove agent's call to an iTarang rep
                                            would misstate who owns the lead. */}
                                        {t.performed_by_name ? (
                                            <div className="text-[11px] text-gray-500 mt-0.5">
                                                by {t.performed_by_name}
                                            </div>
                                        ) : t.external_agent_name ? (
                                            <div className="text-[11px] text-gray-500 mt-0.5">
                                                by {t.external_agent_name}{" "}
                                                <span className="text-gray-400">
                                                    (NeoDove agent)
                                                </span>
                                            </div>
                                        ) : null}
                                        {/* E-236. Above `remarks`, because the
                                            disposition is the structured version
                                            of what that prose line has always
                                            said — "[NeoDove] Disposition: … ·
                                            Tag: …". The remark stays: it also
                                            carries the telecaller's own words,
                                            which nothing else holds. */}
                                        {t.disposition && (
                                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                                <span
                                                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                                                        t.disposition_bucket &&
                                                        isDispositionBucket(
                                                            t.disposition_bucket,
                                                        )
                                                            ? DISPOSITION_BUCKET_TONE[
                                                                  t.disposition_bucket
                                                              ]
                                                            : DISPOSITION_NEUTRAL_TONE
                                                    }`}
                                                >
                                                    {t.disposition}
                                                </span>
                                                <span className="text-[11px] text-gray-400">
                                                    {t.connect_status === "not_connected"
                                                        ? "Not connected"
                                                        : t.disposition_bucket
                                                          ? `Connected · ${t.disposition_bucket}`
                                                          : "Connected"}
                                                </span>
                                            </div>
                                        )}
                                        {t.remarks && (
                                            <p className="text-sm text-gray-700 mt-1.5 whitespace-pre-wrap">
                                                {t.remarks}
                                            </p>
                                        )}
                                        {t.call_duration_sec != null && (
                                            <div className="text-[11px] text-gray-500 mt-1">
                                                Duration: {formatDuration(t.call_duration_sec)}
                                            </div>
                                        )}
                                        {/* Rendered inline rather than behind a
                                            "listen" dialog: the reason to open a
                                            lead's history is usually to hear what
                                            was said, and `preload="none"` means
                                            nothing is fetched until play is
                                            pressed, so a timeline of 8 calls costs
                                            no bandwidth. The link is the fallback
                                            for whatever codec the browser refuses
                                            and for downloading the file. */}
                                        {t.recording_url && (
                                            <div className="mt-2 space-y-1">
                                                <audio
                                                    controls
                                                    preload="none"
                                                    src={t.recording_url}
                                                    className="w-full h-8"
                                                />
                                                <a
                                                    href={t.recording_url}
                                                    target="_blank"
                                                    rel="noreferrer noopener"
                                                    className="inline-flex items-center gap-1 text-[11px] text-sky-700 underline"
                                                >
                                                    Open recording
                                                </a>
                                            </div>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>

                    {shown < touchpoints.length && (
                        <button
                            onClick={() => setShown((n) => n + PAGE)}
                            className="mt-4 w-full rounded-lg border border-gray-200 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                        >
                            Show {Math.min(PAGE, touchpoints.length - shown)} more
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
