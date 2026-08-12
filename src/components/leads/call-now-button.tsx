// "Call now" — per-lead priority dial through NeoDove (E-226).
//
// THE WORDING IS THE DESIGN. Every string here says *requested* / *queued*, and
// none says *calling*. NeoDove has no dial API: this pushes the lead into the
// campaign marked as the priority-dial destination, and it is that campaign's
// NeoDove-side lead distribution — not anything the CRM sends — that puts it in
// front of an agent. An operator who reads "calling…" and hears silence will
// conclude the integration is broken; one who reads "queued for the calling
// team" knows exactly what happened and what to check.
//
// WHY IT STILL CONFIRMS. There is no campaign to choose (there is exactly one
// priority destination, enforced by a unique index), so this is not the full
// SendToNeodoveModal. But the push is irreversible and spends NeoDove plan
// quota, so it is not a bare one-click either — the confirm names the
// destination and, on refusal, is where the exclusion override lives.

"use client";

import { useState } from "react";
import Link from "next/link";
import { PhoneCall, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

function isActivelyWorkedError(message: string): boolean {
    return message.includes("force");
}

function isNoDestinationError(message: string): boolean {
    return message.includes("priority-dial destination");
}

export function CallNowButton({
    leadId,
    leadName,
    disabled,
    onQueued,
}: {
    leadId: string;
    leadName: string;
    disabled?: boolean;
    onQueued?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [force, setForce] = useState(false);
    const [queuedTo, setQueuedTo] = useState<string | null>(null);

    function close() {
        setOpen(false);
        setError(null);
        setForce(false);
        setSending(false);
        setQueuedTo(null);
    }

    async function dial() {
        if (sending) return;
        setSending(true);
        setError(null);
        try {
            const res = await fetch(`/api/neodove/leads/${leadId}/dial`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(force ? { force: true } : {}),
            });
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Could not queue this lead");
            }
            setQueuedTo(json.data?.campaignName ?? "the priority campaign");
            onQueued?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not queue this lead");
        } finally {
            setSending(false);
        }
    }

    return (
        <>
            <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen(true)}
                disabled={disabled}
                title="Push this lead to the NeoDove priority queue so it is called next"
                className={`flex items-center gap-2 text-amber-700 border-amber-200 hover:bg-amber-50 ${
                    disabled ? "opacity-40 cursor-not-allowed" : ""
                }`}
            >
                <PhoneCall className="w-3.5 h-3.5" />
                Call now
            </Button>

            {open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                    <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
                        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
                            <h2 className="text-base font-semibold text-gray-900">
                                {queuedTo ? "Queued for calling" : "Call this lead next"}
                            </h2>
                            <button
                                onClick={close}
                                className="text-gray-400 hover:text-gray-600"
                                aria-label="Close"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {queuedTo ? (
                            <div className="px-6 py-6 space-y-3">
                                <p className="text-sm text-gray-900">
                                    <strong>{leadName}</strong> was pushed to{" "}
                                    <strong>{queuedTo}</strong> for immediate calling.
                                </p>
                                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                                    Whether an agent picks it up straight away depends on
                                    that campaign&apos;s lead distribution inside NeoDove —
                                    the CRM cannot make a phone ring. The call will appear
                                    on this lead&apos;s timeline once NeoDove reports the
                                    outcome.
                                </p>
                                <div className="flex justify-end">
                                    <button
                                        onClick={close}
                                        className="rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800"
                                    >
                                        Done
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="px-6 py-5 space-y-4">
                                    <p className="text-sm text-gray-600">
                                        Push{" "}
                                        <strong className="text-gray-900">{leadName}</strong>{" "}
                                        to the top of the NeoDove calling queue. This spends
                                        one NeoDove lead slot and cannot be undone.
                                    </p>

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
                                                        onChange={(e) => {
                                                            setForce(e.target.checked);
                                                            setError(null);
                                                        }}
                                                        className="mt-0.5"
                                                    />
                                                    <span>
                                                        Hand over anyway. NeoDove will call a
                                                        lead someone here is already working —
                                                        both may contact the same dealer.
                                                    </span>
                                                </label>
                                            )}
                                            {isNoDestinationError(error) && (
                                                <Link
                                                    href="/leads/neodove-campaigns"
                                                    className="inline-block text-xs font-medium text-rose-900 underline"
                                                >
                                                    Set a priority-dial campaign
                                                </Link>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
                                    <button
                                        onClick={close}
                                        className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={dial}
                                        disabled={sending}
                                        className="flex items-center gap-2 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                                    >
                                        <PhoneCall className="w-3.5 h-3.5" />
                                        {sending
                                            ? "Queueing…"
                                            : force
                                              ? "Hand over anyway"
                                              : "Queue for calling"}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
