"use client";

// Bulk-selection bar for the merged Leads list.
//
// STICKY on purpose. It used to render above the table, which meant that once
// you scrolled far enough to tick a row it was off-screen — you could build a
// selection and never see the actions for it. It now pins to the bottom of the
// viewport, so the selection and what you can do with it are always together.
//
// It also carries the "select all N matching" escape hatch. The header checkbox
// reaches one page (10–100 rows); against a few thousand leads that is not a
// bulk action, so when the whole page is ticked and more matches exist, this
// offers the rest.

import { useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import { BulkActionBar } from "@/app/(dashboard)/admin/_components/BulkActionBar";
import type { LeadsCapabilities } from "@/lib/leads/access";

type Props = {
    selectedCount: number;
    /** Rows currently rendered on this page. */
    pageCount: number;
    /** Total rows matching the active filters, across all pages. */
    total: number;
    /** True once every row on this page is ticked. */
    allOnPageSelected: boolean;
    /** True when the selection already covers every match. */
    allMatchingSelected: boolean;
    selectAllMatching: () => void;
    /** Select exactly the first n matching leads, replacing the selection. */
    selectFirstN: (n: number) => void;
    selectingAll: boolean;
    /** Set when the match count exceeded what a bulk action accepts. */
    cappedAt: number | null;
    onClear: () => void;
    caps: LeadsCapabilities;
    selectedIds: string[];
    onBulkDone: () => void;
    onSendToNeodove: () => void;
};

export function LeadsSelectionBar({
    selectedCount,
    pageCount,
    total,
    allOnPageSelected,
    allMatchingSelected,
    selectAllMatching,
    selectFirstN,
    selectingAll,
    cappedAt,
    onClear,
    caps,
    selectedIds,
    onBulkDone,
    onSendToNeodove,
}: Props) {
    // Held as a STRING, not a number: a controlled number input coerced through
    // Number() cannot be cleared — backspacing to empty yields NaN and snaps
    // back to the last value, so the field fights anyone retyping it.
    const [countDraft, setCountDraft] = useState("");

    if (selectedCount === 0) return null;

    // Only worth offering when the page is fully ticked and there is more
    // beyond it — otherwise it is noise on a partial selection.
    const offerSelectAll =
        allOnPageSelected && !allMatchingSelected && total > pageCount;

    return (
        <div className="sticky bottom-4 z-30 mt-3">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50/95 px-4 py-3 shadow-lg backdrop-blur">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="text-sm text-sky-900">
                        <strong className="tabular-nums">
                            {selectedCount.toLocaleString("en-IN")}
                        </strong>{" "}
                        lead{selectedCount === 1 ? "" : "s"} selected
                    </p>

                    {offerSelectAll && (
                        <button
                            onClick={selectAllMatching}
                            disabled={selectingAll}
                            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-sky-700 underline underline-offset-2 transition-colors hover:bg-sky-100 disabled:opacity-60"
                        >
                            {selectingAll && (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            Select all {total.toLocaleString("en-IN")} matching these
                            filters
                        </button>
                    )}

                    {/* Select exactly N.
                        The header checkbox takes a whole page and "select all
                        matching" takes everything; between them there was no way
                        to say "give me 65", which is the shape most hand-offs
                        actually have — a batch sized to what the calling team
                        can work, not to a page size. */}
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            const n = Number(countDraft);
                            if (Number.isFinite(n) && n >= 1) selectFirstN(n);
                        }}
                        className="flex items-center gap-1.5"
                    >
                        <label className="text-xs text-sky-800" htmlFor="select-n">
                            Select
                        </label>
                        <input
                            id="select-n"
                            type="number"
                            min={1}
                            max={total}
                            inputMode="numeric"
                            value={countDraft}
                            onChange={(e) => setCountDraft(e.target.value)}
                            placeholder={String(Math.min(total, 100))}
                            className="w-20 rounded-lg border border-sky-200 bg-white px-2 py-1 text-xs tabular-nums text-sky-900 outline-none focus:border-sky-400"
                        />
                        <button
                            type="submit"
                            disabled={selectingAll || !countDraft}
                            className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
                        >
                            {selectingAll && (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            Apply
                        </button>
                    </form>

                    {allMatchingSelected && (
                        <span className="text-xs text-sky-700">
                            All matching leads are selected.
                        </span>
                    )}

                    {cappedAt !== null && (
                        // Say it plainly rather than silently handing back fewer
                        // ids than the user asked for.
                        <span className="text-xs font-medium text-amber-700">
                            Capped at {cappedAt.toLocaleString("en-IN")} — the most a
                            bulk action accepts.
                        </span>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <button
                        onClick={onClear}
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-sky-900 transition-all hover:bg-sky-100"
                    >
                        <X className="h-3.5 w-3.5" />
                        Clear
                    </button>

                    {caps.canBulkAct && (
                        <BulkActionBar
                            selectedIds={selectedIds}
                            onClear={onClear}
                            onActionDone={onBulkDone}
                        />
                    )}

                    {caps.canSendToNeodove && (
                        <button
                            onClick={onSendToNeodove}
                            className="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-gray-800"
                        >
                            <Send className="h-3.5 w-3.5" />
                            Send to NeoDove
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
