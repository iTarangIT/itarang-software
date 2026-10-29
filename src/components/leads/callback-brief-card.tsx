"use client";

// D8 — the open callback on a lead, at the top of the lead page: what Priya
// promised, when, who owns it, and the call brief the ISR reads before she
// dials. A complaint carries a "Resolve" button: it closes only when someone
// resolves it (until then the AI does not call the lead).
//
// Reads /api/inside-sales/lead/[id]/callback. Renders nothing when there is no
// open callback (or the database has no E-356).

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PhoneCall, ShieldAlert } from "lucide-react";

import { CALL_CATEGORY_LABELS, isCallCategory } from "@/lib/ai-dialer/callCategory";

type Brief = {
    purpose?: string;
    shop?: string | null;
    city?: string | null;
    productLines?: string[];
    volume?: string | null;
    promise?: string;
    openQuestions?: string[];
    secondNumber?: string | null;
    summary?: string | null;
};

type OpenCallback = {
    owner_type: "ai" | "sales";
    status: string;
    topic: string | null;
    category: string | null;
    requested_text: string | null;
    due_at: string;
    /** Server clock — keeps render pure. */
    overdue: boolean;
    attempts: number;
    summary: string | null;
    kind: string | null;
    brief: Brief | null;
    assigned_name: string | null;
};

const KIND_TITLE: Record<string, string> = {
    sales: "Callback promised on an AI call",
    qualified: "Qualified on an AI call — call the dealer",
    complaint: "Complaint raised on an AI call",
};

export function CallbackBriefCard({ leadId, className = "" }: { leadId: string; className?: string }) {
    const qc = useQueryClient();
    const [busy, setBusy] = useState(false);
    const q = useQuery({
        queryKey: ["lead-ai-callback", leadId],
        staleTime: 30_000,
        queryFn: async () => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/callback`, {
                cache: "no-store",
            });
            const json = (await res.json()) as { data?: { callback: OpenCallback | null } };
            return json.data?.callback ?? null;
        },
    });
    const cb = q.data;
    if (!cb) return null;

    const sales = cb.owner_type === "sales";
    const complaint = cb.kind === "complaint";
    const due = new Date(cb.due_at).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    });
    const b = cb.brief;

    async function resolve() {
        setBusy(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/callback`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "resolve_complaint" }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Could not resolve");
            toast.success("Complaint resolved.");
            qc.invalidateQueries({ queryKey: ["lead-ai-callback", leadId] });
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not resolve");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            className={`rounded-xl border px-4 py-3 text-sm ${
                complaint
                    ? "border-rose-200 bg-rose-50"
                    : sales
                      ? "border-orange-200 bg-orange-50"
                      : "border-sky-200 bg-sky-50"
            } ${className}`}
        >
            <div className="flex flex-wrap items-center gap-2 font-semibold text-gray-900">
                {complaint ? <ShieldAlert className="h-4 w-4" /> : <PhoneCall className="h-4 w-4" />}
                {sales
                    ? (KIND_TITLE[cb.kind ?? "sales"] ?? KIND_TITLE.sales)
                    : "Callback requested — the AI will call back"}
                {cb.assigned_name && (
                    <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        {cb.assigned_name}
                    </span>
                )}
                {complaint && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={resolve}
                        className="ml-auto rounded-md border border-rose-300 bg-white px-2 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    >
                        Mark resolved
                    </button>
                )}
            </div>
            <p className={`mt-1 text-xs ${cb.overdue ? "font-semibold text-rose-700" : "text-gray-700"}`}>
                Due {due}
                {cb.overdue && " · overdue"}
                {cb.requested_text && ` · dealer said “${cb.requested_text}”`}
            </p>
            {b?.purpose && <p className="mt-2 text-xs font-medium text-gray-900">{b.purpose}</p>}
            {b ? (
                <ul className="mt-1 space-y-0.5 text-xs text-gray-700">
                    {b.productLines && b.productLines.length > 0 && <li>Lines: {b.productLines.join(", ")}</li>}
                    {b.volume && <li>Volume: {b.volume}</li>}
                    {b.openQuestions && b.openQuestions.length > 0 && (
                        <li>Not answered on the call: {b.openQuestions.join(", ")}</li>
                    )}
                    {b.secondNumber && <li>Second number: {b.secondNumber}</li>}
                    {(b.summary ?? cb.summary) && <li className="text-gray-600">{b.summary ?? cb.summary}</li>}
                </ul>
            ) : (
                <>
                    <p className="mt-1 text-xs text-gray-600">
                        {cb.category && isCallCategory(cb.category) ? CALL_CATEGORY_LABELS[cb.category] : "Callback"}
                        {cb.topic && cb.topic !== "none" && ` · topic: ${cb.topic.replace(/_/g, " ")}`}
                        {!sales && cb.attempts > 0 && ` · ${cb.attempts} AI attempt${cb.attempts === 1 ? "" : "s"}`}
                    </p>
                    {cb.summary && <p className="mt-1 text-xs text-gray-600">{cb.summary}</p>}
                </>
            )}
            {sales && !complaint && (
                <p className="mt-1 text-[11px] text-gray-500">
                    Closes when the dealer is reached — a connected NeoDove call, a logged call, visit or WhatsApp chat.
                </p>
            )}
        </div>
    );
}
