"use client";

/**
 * Calls — every human call on the lead, newest first (NeoDove task, 26 Nov):
 * when it happened, who made it, connected or not, and NeoDove's status, stage,
 * outcome and follow-up date, with duration, recording and what the caller
 * typed. Reads /api/inside-sales/lead/[id]/calls (src/lib/leads/leadCallHistory.ts).
 * AI-dialer calls stay on the "AI calls" tab.
 */
import { useQuery } from "@tanstack/react-query";
import { Loader2, PhoneCall, PhoneOff } from "lucide-react";

import type { LeadCall } from "@/lib/leads/leadCallHistory";
import { CALL_STATUS_LABEL } from "@/lib/lifecycle/touchpointLabels";
// ID 166: a recording plays through a fresh 15-minute link, as on the admin lead page.
import FreshAudio from "@/components/shared/FreshAudio";
import { onFreshFileClick } from "@/lib/storage/freshFileLink";

type Resp = { success?: boolean; data?: { calls: LeadCall[]; truncated: boolean }; error?: { message?: string } };

const when = (iso: string | null) =>
    iso
        ? new Date(iso).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
          })
        : "—";

const duration = (s: number | null) => (s == null ? null : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);

// NeoDove's names now, and the older names it sent before ~26 Oct (Follow-Up, Open, Closed).
const STATUS_TONE: Record<string, string> = {
    "In-Progress": "border-sky-200 bg-sky-50 text-sky-800",
    "Follow-Up": "border-sky-200 bg-sky-50 text-sky-800",
    Uncontacted: "border-gray-200 bg-gray-50 text-gray-700",
    Open: "border-gray-200 bg-gray-50 text-gray-700",
    Lost: "border-rose-200 bg-rose-50 text-rose-800",
    Closed: "border-rose-200 bg-rose-50 text-rose-800",
    Converted: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

function Centered({ children }: { children: React.ReactNode }) {
    return <div className="flex h-full items-center justify-center px-6 py-16 text-center">{children}</div>;
}

export function CallHistoryPane({ leadId }: { leadId: string }) {
    const q = useQuery({
        queryKey: ["lead-calls", leadId],
        staleTime: 30_000,
        queryFn: async () => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/calls`, { cache: "no-store" });
            const json = (await res.json().catch(() => ({}))) as Resp;
            if (!res.ok || json.success === false) throw new Error(json.error?.message ?? "Couldn't load calls. Try again.");
            return json.data ?? { calls: [], truncated: false };
        },
    });

    if (q.isLoading)
        return (
            <Centered>
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </Centered>
        );
    if (q.isError)
        return (
            <Centered>
                <p className="text-sm text-rose-600">{q.error instanceof Error ? q.error.message : "Failed to load calls"}</p>
            </Centered>
        );
    const calls = q.data?.calls ?? [];
    if (calls.length === 0)
        return (
            <Centered>
                <div>
                    <PhoneOff className="mx-auto h-8 w-8 text-gray-300" />
                    <p className="mt-3 text-sm font-medium text-gray-700">No calls yet</p>
                    <p className="mt-1 text-xs text-gray-500">Calls logged in the CRM and calls made in NeoDove show here.</p>
                </div>
            </Centered>
        );

    const neodove = calls.filter((c) => c.source === "neodove").length;
    const connected = calls.filter((c) => c.connected).length;
    return (
        <div className="h-full overflow-y-auto" data-testid="call-history">
            <div className="sticky top-0 z-10 border-b border-gray-100 bg-white px-6 py-2.5 text-xs text-gray-500">
                {calls.length} {calls.length === 1 ? "call" : "calls"}
                {q.data?.truncated ? " (latest 300)" : ""} · {connected} connected · {neodove} from NeoDove, {calls.length - neodove} logged in the CRM
            </div>
            <ol className="divide-y divide-gray-100">
                {calls.map((c) => (
                    <li key={c.id} className="px-6 py-3" data-testid="call-row">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <PhoneCall className={`h-3.5 w-3.5 ${c.connected ? "text-emerald-600" : "text-gray-400"}`} aria-hidden />
                                <span className="text-sm font-semibold text-gray-900 tabular-nums" data-testid="call-time">
                                    {when(c.at)}
                                </span>
                                <span
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                        c.source === "neodove" ? "bg-violet-50 text-violet-700" : "bg-gray-100 text-gray-600"
                                    }`}
                                >
                                    {c.source === "neodove" ? "NeoDove" : "CRM"}
                                </span>
                            </div>
                            <span className={`text-xs font-medium ${c.connected ? "text-emerald-700" : "text-gray-500"}`}>
                                {c.connected === true
                                    ? "Connected"
                                    : c.call_status
                                      ? (CALL_STATUS_LABEL as Record<string, string>)[c.call_status] ?? c.call_status.replace(/_/g, " ")
                                      : c.connected === false
                                        ? "Not connected"
                                        : "Connection not recorded"}
                                {duration(c.duration_sec) ? ` · ${duration(c.duration_sec)}` : ""}
                            </span>
                        </div>
                        {c.by && (
                            <div className="mt-0.5 text-[11px] text-gray-500">
                                by {c.by}
                                {c.by_external ? <span className="text-gray-400"> (NeoDove agent, no CRM login linked)</span> : null}
                                {c.campaign ? <span className="text-gray-400"> · {c.campaign}</span> : null}
                            </div>
                        )}
                        {(c.status || c.stage || c.outcome || c.follow_up_at) && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                                {c.status && (
                                    <span
                                        className={`rounded-full border px-2 py-0.5 font-medium ${STATUS_TONE[c.status] ?? "border-gray-200 bg-white text-gray-700"}`}
                                        title={c.status_code ? `NeoDove status code ${c.status_code}` : undefined}
                                        data-testid="call-status"
                                    >
                                        {c.status}
                                    </span>
                                )}
                                {c.stage && <span className="rounded-full border border-gray-200 px-2 py-0.5 text-gray-600">Stage: {c.stage}</span>}
                                {c.outcome && <span className="rounded-full border border-gray-200 px-2 py-0.5 text-gray-700">Outcome: {c.outcome}</span>}
                                {c.follow_up_at && (
                                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800" data-testid="call-follow-up">
                                        Follow-up in NeoDove: {when(c.follow_up_at)}
                                    </span>
                                )}
                            </div>
                        )}
                        {c.note ? (
                            <p className="mt-1.5 whitespace-pre-wrap text-sm text-gray-700">“{c.note}”</p>
                        ) : c.source === "crm" && c.remarks ? (
                            <p className="mt-1.5 whitespace-pre-wrap text-sm text-gray-700">{c.remarks}</p>
                        ) : null}
                        {c.source === "neodove" && !c.status && c.remarks && (
                            // No original message kept for this call (older than the ledger): the stored line.
                            <p className="mt-1.5 text-xs text-gray-500">{c.remarks}</p>
                        )}
                        {c.recording_url && (
                            <div className="mt-2 space-y-1" data-testid="call-recording">
                                <FreshAudio preload="none" src={c.recording_url} className="h-8 w-full max-w-md" />
                                <a
                                    href={c.recording_url}
                                    onClick={(e) => onFreshFileClick(e, c.recording_url)}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="inline-flex items-center gap-1 text-[11px] text-sky-700 underline"
                                >
                                    Open recording
                                </a>
                            </div>
                        )}
                    </li>
                ))}
            </ol>
        </div>
    );
}
