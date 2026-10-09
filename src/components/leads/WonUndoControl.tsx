"use client";

// Undo Mark Won on a Won lead (tracker ID 134) — /api/inside-sales/lead/[id]/won-undo.
//
//   owner (rep / ASM)    "Request undo" with a reason → waits for the Sales Head
//   Sales Head / admin   a waiting request: Approve (one click) or Refuse (with
//                        a note); no request: "Undo Mark Won" with a reason
//
// Only while the dealer has not submitted onboarding; the server says when it
// is too late and why, and the control then shows that sentence instead.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type UndoState = {
    available: boolean;
    eligible: boolean;
    reason: string | null;
    restore_status: string | null;
    pending: {
        id: string;
        requested_by: string;
        requested_by_name: string | null;
        requested_at: string;
        request_reason: string;
    } | null;
    can_request: boolean;
    can_approve: boolean;
};

const pretty = (s: string | null) => (s ?? "").replace(/_/g, " ");

export function WonUndoControl({ leadId, onDone }: { leadId: string; onDone?: () => void }) {
    const qc = useQueryClient();
    const key = ["won-undo", leadId];
    const q = useQuery<UndoState>({
        queryKey: key,
        queryFn: async () => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/won-undo`, { cache: "no-store" });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Could not load");
            return json.data as UndoState;
        },
    });
    const [mode, setMode] = useState<null | "request" | "undo" | "reject">(null);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const s = q.data;
    if (!s || !s.available) return null;
    if (!s.can_request && !s.can_approve) return null;

    async function send(body: Record<string, unknown>, ok: string) {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/won-undo`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || json?.success === false) throw new Error(json?.error?.message ?? "Request failed");
            toast.success(ok);
            setMode(null);
            setText("");
            await qc.invalidateQueries({ queryKey: key });
            onDone?.();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    // A waiting request — the approver decides, the owner sees it is waiting.
    if (s.pending) {
        const who = s.pending.requested_by_name ?? "The owner";
        if (!s.can_approve) {
            return (
                <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                    <Undo2 className="h-3 w-3" />
                    Undo requested — waiting for the Sales Head
                </span>
            );
        }
        return (
            <div className="basis-full max-w-lg rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                    <Undo2 className="h-3.5 w-3.5 text-amber-700" />
                    {who} asks to undo Mark Won
                </h3>
                <p className="mt-1 text-[12px] text-gray-700">“{s.pending.request_reason}”</p>
                {s.eligible ? (
                    <p className="mt-1 text-[11px] text-gray-600">
                        Approving puts the lead back at <span className="font-medium">{pretty(s.restore_status)}</span>{" "}
                        with the same owner, withdraws the empty onboarding application and removes the Won.
                    </p>
                ) : (
                    <p className="mt-1 text-[11px] text-rose-700">{s.reason}</p>
                )}
                {mode === "reject" && (
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={2}
                        placeholder="Why is the undo refused? (required)"
                        disabled={busy}
                        className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                    />
                )}
                {error && <p className="mt-2 text-[12px] text-rose-700">{error}</p>}
                <div className="mt-2 flex items-center justify-end gap-2">
                    {mode === "reject" ? (
                        <>
                            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setMode(null)}>
                                Back
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                disabled={busy || text.trim().length < 5}
                                onClick={() => send({ action: "reject", note: text.trim() }, "Undo refused.")}
                            >
                                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                                Refuse undo
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setMode("reject")}>
                                Refuse
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                disabled={busy || !s.eligible}
                                onClick={() => send({ action: "approve" }, "Mark Won undone.")}
                            >
                                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                                Approve undo
                            </Button>
                        </>
                    )}
                </div>
            </div>
        );
    }

    // No request yet. Too late to undo → nothing to offer.
    if (!s.eligible) return null;

    const action = s.can_approve ? "undo" : "request";
    if (mode === null) {
        return (
            <button
                type="button"
                onClick={() => setMode(action)}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
                <Undo2 className="h-3 w-3" />
                {action === "undo" ? "Undo Mark Won" : "Request undo"}
            </button>
        );
    }

    return (
        <div className="basis-full max-w-lg rounded-lg border border-gray-200 bg-gray-50 p-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <Undo2 className="h-3.5 w-3.5 text-gray-500" />
                {action === "undo" ? "Undo Mark Won" : "Ask the Sales Head to undo Mark Won"}
            </h3>
            <p className="mt-1 text-[11px] text-gray-600">
                For a Won marked by mistake. The lead goes back to{" "}
                <span className="font-medium">{pretty(s.restore_status)}</span> with the same owner, the empty
                onboarding application is withdrawn and the Won is not counted. It is not a drop-out or a Lost.
            </p>
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={2}
                placeholder="What was the mistake? (required)"
                disabled={busy}
                className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
            />
            {error && <p className="mt-2 text-[12px] text-rose-700">{error}</p>}
            <div className="mt-2 flex items-center justify-end gap-2">
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setMode(null)}>
                    Cancel
                </Button>
                <Button
                    type="button"
                    size="sm"
                    disabled={busy || text.trim().length < 5}
                    onClick={() =>
                        send(
                            { action, reason: text.trim() },
                            action === "undo" ? "Mark Won undone." : "Undo requested — the Sales Head will decide.",
                        )
                    }
                >
                    {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    {action === "undo" ? "Undo Mark Won" : "Request undo"}
                </Button>
            </div>
        </div>
    );
}
