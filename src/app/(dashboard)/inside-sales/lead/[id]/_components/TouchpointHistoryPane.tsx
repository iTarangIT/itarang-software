"use client";

import { AlarmClock, Download } from "lucide-react";
import type {
    LeadDetailLimitEvent,
    LeadDetailStatusHistory,
    LeadDetailTouchpoint,
} from "@/lib/inside-sales/types";
import { limitEventOwnerLine, limitEventTitle } from "@/lib/leads/limitEventLabels";
import {
    TOUCHPOINT_ICONS as ICONS,
    TOUCHPOINT_TYPE_LABEL as TYPE_LABEL,
} from "@/lib/lifecycle/touchpointDisplay";

type Props = {
    leadId: string;
    touchpoints: LeadDetailTouchpoint[];
    statusHistory: LeadDetailStatusHistory[];
    /** IDs 85 / 86 — missed time limits on this lead, listed above the touchpoints. */
    limitEvents?: LeadDetailLimitEvent[];
    /**
     * Offer "Export to Excel". Defaults to true for the admin-only escalation
     * view; the lead pages pass canExportLeadHistory() so a rep sees the button
     * only on a lead they own (ID 58) — the route refuses the rest.
     */
    canExport?: boolean;
};

type Attachment = { url: string; type: string | null; reused: boolean };

// touchpoints.attachments is untyped jsonb: keep only entries with a url.
function readAttachments(raw: unknown[] | undefined): Attachment[] {
    return (raw ?? []).flatMap((a) => {
        const o = a as { url?: unknown; type?: unknown; reused?: unknown } | null;
        if (!o || typeof o.url !== "string" || !o.url) return [];
        return [{ url: o.url, type: typeof o.type === "string" ? o.type : null, reused: o.reused === true }];
    });
}

const IMAGE_URL = /\.(jpe?g|png|webp|gif)(\?|$)/i;

// ID 79: a WhatsApp screenshot (or any image) shows as a thumbnail that opens
// the full image; other files as a link. A reused screenshot is flagged.
function Attachments({ items }: { items: Attachment[] }) {
    if (items.length === 0) return null;
    return (
        <div className="mt-2 flex flex-wrap gap-2">
            {items.map((a) =>
                a.type === "whatsapp_screenshot" || IMAGE_URL.test(a.url) ? (
                    <a
                        key={a.url}
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group relative block"
                        title="Open the full image"
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element -- auth-proxied /api/files URL, not optimisable */}
                        <img
                            src={a.url}
                            alt="WhatsApp screenshot"
                            className={`h-24 w-24 rounded-md border object-cover group-hover:opacity-90 ${a.reused ? "border-rose-400" : "border-gray-200"}`}
                        />
                        {a.reused && (
                            <span className="absolute left-1 top-1 rounded bg-rose-600 px-1 py-0.5 text-[9px] font-semibold uppercase text-white">
                                Reused
                            </span>
                        )}
                    </a>
                ) : (
                    <a
                        key={a.url}
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-blue-600 hover:underline"
                    >
                        View attachment
                    </a>
                ),
            )}
        </div>
    );
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function TouchpointHistoryPane({ leadId, touchpoints, limitEvents = [], canExport = true }: Props) {
    return (
        <div className="overflow-y-auto border-r border-gray-100 bg-white">
            <div className="px-6 py-4 sticky top-0 bg-white border-b border-gray-100 z-[1] flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-gray-900">Touchpoint History</h2>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                        {touchpoints.length} {touchpoints.length === 1 ? "entry" : "entries"} · newest first
                    </p>
                </div>
                {canExport && (
                    <a
                        href={`/api/inside-sales/lead/${encodeURIComponent(leadId)}/history/export.xlsx`}
                        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                        <Download className="h-3.5 w-3.5" />
                        Export to Excel
                    </a>
                )}
            </div>
            <div className="px-6 py-4">
                {limitEvents.length > 0 && (
                    <div className="mb-4 rounded-lg border border-rose-100 bg-rose-50/50 px-3 py-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-800">
                            <AlarmClock className="h-3.5 w-3.5" />
                            {limitEvents.length} time limit{limitEvents.length === 1 ? "" : "s"} passed
                        </div>
                        <ul className="mt-1.5 space-y-1">
                            {limitEvents.map((e) => (
                                <li key={`${e.clock}-${e.passed_at}`} className="text-[11px] text-gray-700">
                                    <span className="font-medium text-rose-800">{limitEventTitle(e)}</span>
                                    <span className="text-gray-500"> · {formatTime(e.passed_at)} · {limitEventOwnerLine(e)}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {touchpoints.length === 0 ? (
                    <div className="text-sm text-gray-500 py-10 text-center">
                        No touchpoints logged yet. Use the action bar below to log the first one.
                    </div>
                ) : (
                    <ol className="space-y-3">
                        {touchpoints.map((t) => {
                            const Icon = ICONS[t.touchpoint_type] ?? ICONS.default;
                            // ID 191: a failed quote send (merged from quotation_dispatches) shows in red.
                            const failed = t.tone === "failed";
                            return (
                                <li key={t.touchpoint_id} className="flex gap-3">
                                    <div className="shrink-0 mt-0.5">
                                        <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${failed ? "bg-rose-50 text-rose-600" : t.is_engaged ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-500"}`}>
                                            <Icon className="h-4 w-4" />
                                        </div>
                                    </div>
                                    <div className={`flex-1 min-w-0 rounded-lg border px-3 py-2 ${failed ? "border-rose-200 bg-rose-50/60" : "border-gray-100 bg-gray-50/40"}`}>
                                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                                            <div className={`text-sm font-medium ${failed ? "text-rose-800" : "text-gray-900"}`}>
                                                {t.display_label ?? TYPE_LABEL[t.touchpoint_type] ?? t.touchpoint_type}
                                                {t.call_status && (
                                                    <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">
                                                        · {t.call_status}
                                                    </span>
                                                )}
                                                {t.is_engaged && (
                                                    <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                                                        engaged
                                                    </span>
                                                )}
                                                {/* ID 83: made by the calling team after the
                                                    owner's "Call now" — not the owner's own call. */}
                                                {t.called_on_behalf && (
                                                    <span
                                                        className="ml-2 text-[10px] uppercase tracking-wide text-sky-800 bg-sky-100 px-1.5 py-0.5 rounded"
                                                        title="Made by the NeoDove calling team after the owner's Call now request"
                                                    >
                                                        called on owner&apos;s behalf
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-[11px] text-gray-500 tabular-nums">{formatTime(t.performed_at)}</div>
                                        </div>
                                        {t.performed_by_name && (
                                            <div className="text-[11px] text-gray-500 mt-0.5">by {t.performed_by_name}</div>
                                        )}
                                        {t.remarks && (
                                            <p className={`text-sm mt-1.5 whitespace-pre-wrap ${failed ? "text-rose-800" : "text-gray-700"}`}>{t.remarks}</p>
                                        )}
                                        {t.call_duration_sec != null && (
                                            <div className="text-[11px] text-gray-500 mt-1">
                                                Duration: {Math.floor(t.call_duration_sec / 60)}m {t.call_duration_sec % 60}s
                                            </div>
                                        )}
                                        <Attachments items={readAttachments(t.attachments)} />
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                )}
            </div>
        </div>
    );
}
