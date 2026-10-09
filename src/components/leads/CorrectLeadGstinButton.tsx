"use client";

// "Correct GSTIN" for a Won lead (tracker ID 124) — fixes a GSTIN typo on the
// lead AND its onboarding application together, with a reason. Replaces
// pressing Mark Won a second time, which changed only the lead.
// POST /api/inside-sales/lead/[id]/gstin.
//
// Render it only on a Won lead, for the owner, the Sales Head or admin; the
// endpoint refuses anything else.

import { useState } from "react";
import { toast } from "sonner";
import { FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GSTIN_CORRECTION_REASON_MIN } from "@/lib/leads/correctLeadGstinRules";
import { checkCustomerGstin, GSTIN_CHECK_MESSAGE, normalizeGstin } from "@/lib/leads/gstin";

export function CorrectLeadGstinButton({
    leadId,
    currentGstin,
    onDone,
}: {
    leadId: string;
    currentGstin: string | null;
    onDone?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [gstin, setGstin] = useState("");
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const normalized = normalizeGstin(gstin);
    const check = normalized ? checkCustomerGstin(normalized) : null;
    const same = !!currentGstin && normalizeGstin(currentGstin) === normalized;
    const ready = check === "ok" && !same && reason.trim().length >= GSTIN_CORRECTION_REASON_MIN;

    async function submit() {
        if (!ready) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/gstin`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gstin: normalized, reason: reason.trim() }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || json?.success === false) throw new Error(json?.error?.message ?? "Could not correct the GSTIN");
            toast.success(
                json?.data?.applicationId ? "GSTIN corrected on the lead and the onboarding application." : "GSTIN corrected.",
            );
            setGstin("");
            setReason("");
            setOpen(false);
            onDone?.();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition"
            >
                <FileText className="h-4 w-4" />
                Correct GSTIN
            </button>
        );
    }

    return (
        <div className="basis-full max-w-lg rounded-lg border border-gray-200 bg-gray-50 p-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <FileText className="h-3.5 w-3.5 text-gray-500" />
                Correct GSTIN
            </h3>
            <p className="mt-1 text-[11px] text-gray-600">
                Now: <span className="font-mono font-medium">{currentGstin || "none"}</span>. The new GSTIN goes on the
                lead and its onboarding application together; the old and new number and your reason are logged.
            </p>
            <div className="mt-2 space-y-2">
                <input
                    value={gstin}
                    onChange={(e) => setGstin(e.target.value)}
                    placeholder="Correct GSTIN (15 characters)"
                    maxLength={20}
                    disabled={busy}
                    className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 font-mono text-sm uppercase"
                />
                {check && check !== "ok" && (
                    <p className="text-[11px] text-rose-600">{GSTIN_CHECK_MESSAGE[check]}</p>
                )}
                {same && <p className="text-[11px] text-rose-600">That is already the lead&apos;s GSTIN.</p>}
                <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    placeholder="Why is the GSTIN being corrected? (required)"
                    disabled={busy}
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-100 disabled:bg-gray-50"
                />
            </div>
            {error && (
                <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                    {error}
                </div>
            )}
            <div className="mt-2 flex items-center justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
                    Cancel
                </Button>
                <Button type="button" size="sm" onClick={submit} disabled={busy || !ready}>
                    {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Save GSTIN
                </Button>
            </div>
        </div>
    );
}
