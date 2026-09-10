"use client";

// Sticky selection bar for the Unassigned (Claim) tab.
//
// Pinned to the bottom of the viewport for the same reason the Leads page bar
// is: a rep ticks rows while scrolling, and the count plus the action must
// stay in view. It is deliberately NOT the admin BulkActionBar — that one is
// gated to admin/sales_head/ceo and carries admin actions; this bar has exactly
// one job, claiming the ticked leads for the viewer.
//
// The cap is a product decision, not a technical one: one rep must not be
// able to take the whole queue in a click, so above BULK_CLAIM_CAP the button
// is disabled and the bar says why.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, UserPlus2, X } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import {
    BULK_CLAIM_CAP,
    type BulkClaimInput,
    type BulkClaimResult,
} from "@/lib/inside-sales/types";

type Props = {
    selectedIds: string[];
    /** Total rows matching the active filters, across all pages. */
    total: number;
    /** Replace the selection with the first n leads in queue order. */
    selectFirstN: (n: number) => void;
    selectingFirstN: boolean;
    onClear: () => void;
    /** Called after a claim request completes (fully or partially). */
    onClaimed: () => void;
};

function summarise(r: BulkClaimResult): string {
    const parts: string[] = [];
    if (r.skipped_already_owned > 0) {
        parts.push(`${r.skipped_already_owned} skipped (already claimed)`);
    }
    if (r.skipped_terminal > 0) parts.push(`${r.skipped_terminal} skipped (closed)`);
    if (r.skipped_not_found > 0) parts.push(`${r.skipped_not_found} skipped (not found)`);
    const head = `Claimed ${r.claimed} lead${r.claimed === 1 ? "" : "s"}`;
    return parts.length ? `${head}, ${parts.join(", ")}` : head;
}

export function BulkClaimBar({
    selectedIds,
    total,
    selectFirstN,
    selectingFirstN,
    onClear,
    onClaimed,
}: Props) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    // Held as a STRING: a controlled number input coerced through Number()
    // cannot be cleared — backspacing to empty yields NaN and snaps back.
    const [countDraft, setCountDraft] = useState("");

    const count = selectedIds.length;
    // Shown even with nothing ticked: "Select first N" is how a rep says "give
    // me a batch" without ticking rows one by one, so it must be reachable
    // before any selection exists. Hidden only when there is nothing to claim.
    if (total === 0) return null;
    const overCap = count > BULK_CLAIM_CAP;
    const maxN = Math.min(total, BULK_CLAIM_CAP);

    const submit = async () => {
        setSubmitting(true);
        try {
            const body: BulkClaimInput = { lead_ids: selectedIds };
            const res = await fetch("/api/inside-sales/lead/bulk-claim", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to claim leads");
            const result = json.data as BulkClaimResult;
            if (result.claimed > 0) toast.success(summarise(result));
            else toast.warning(summarise(result));
            setConfirmOpen(false);
            onClaimed();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <>
            <div className="sticky bottom-4 z-30 mt-3">
                <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50/95 px-4 py-3 shadow-lg backdrop-blur">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {/* Select first N — the rep names a batch size and gets
                            the top N of the queue as it is currently sorted
                            and filtered, capped at what one claim accepts. */}
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                const n = Math.floor(Number(countDraft));
                                if (Number.isFinite(n) && n >= 1) selectFirstN(Math.min(n, maxN));
                            }}
                            className="flex items-center gap-1.5"
                        >
                            <label className="text-xs text-sky-800" htmlFor="claim-select-n">
                                Select first
                            </label>
                            <input
                                id="claim-select-n"
                                type="number"
                                min={1}
                                max={maxN}
                                inputMode="numeric"
                                value={countDraft}
                                onChange={(e) => setCountDraft(e.target.value)}
                                placeholder={String(maxN)}
                                className="w-20 rounded-lg border border-sky-200 bg-white px-2 py-1 text-xs tabular-nums text-sky-900 outline-none focus:border-sky-400"
                            />
                            <button
                                type="submit"
                                disabled={selectingFirstN || !countDraft}
                                className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
                            >
                                {selectingFirstN && <Loader2 className="h-3 w-3 animate-spin" />}
                                Apply
                            </button>
                            <span className="text-[11px] text-sky-700">max {maxN}</span>
                        </form>
                        <p className="text-sm text-sky-900">
                            <strong className="tabular-nums">{count.toLocaleString("en-IN")}</strong>{" "}
                            lead{count === 1 ? "" : "s"} selected
                        </p>
                        {overCap && (
                            <span className="text-xs font-medium text-amber-700">
                                You can claim at most {BULK_CLAIM_CAP} leads at once — untick some.
                            </span>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={onClear}
                            disabled={count === 0}
                            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-sky-900 transition-all hover:bg-sky-100 disabled:opacity-40"
                        >
                            <X className="h-3.5 w-3.5" />
                            Clear
                        </button>
                        <Button
                            type="button"
                            size="sm"
                            className="gap-1.5"
                            disabled={overCap || count === 0}
                            onClick={() => setConfirmOpen(true)}
                        >
                            <UserPlus2 className="h-4 w-4" />
                            Claim {count.toLocaleString("en-IN")} lead{count === 1 ? "" : "s"}
                        </Button>
                    </div>
                </div>
            </div>

            <Modal
                open={confirmOpen}
                onClose={() => !submitting && setConfirmOpen(false)}
                title="Claim Leads"
                width="sm"
                closeOnBackdrop={!submitting}
                footer={
                    <>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setConfirmOpen(false)}
                            disabled={submitting}
                        >
                            Cancel
                        </Button>
                        <Button type="button" onClick={submit} disabled={submitting} className="gap-1.5">
                            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                            {submitting ? "Claiming…" : `Claim ${count} lead${count === 1 ? "" : "s"}`}
                        </Button>
                    </>
                }
            >
                <div className="flex items-start gap-3">
                    <div className="shrink-0 h-10 w-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
                        <UserPlus2 className="h-5 w-5" />
                    </div>
                    <div className="space-y-2 text-sm text-gray-700">
                        <p>
                            You will become the current owner of{" "}
                            <span className="font-semibold text-gray-900">
                                {count} lead{count === 1 ? "" : "s"}
                            </span>
                            .
                        </p>
                        <p className="text-xs text-gray-500">
                            Each lead moves from <code>New_Unassigned</code> to{" "}
                            <code>Assigned_Not_Contacted</code>. Any lead another rep claims
                            first is skipped and reported. You can reassign later from the
                            lead&apos;s action bar if needed.
                        </p>
                    </div>
                </div>
            </Modal>
        </>
    );
}
