// The "NeoDove" provenance chip on a lead row.
//
// Renders NOTHING unless the lead is actually with the calling team, so it can
// be dropped into a row unconditionally. `failed` is not a NeoDove lead (see
// NEODOVE_LINKED_SYNC_STATUSES) and gets no chip.
//
// Sky, matching every other NeoDove affordance in the app — the timeline's
// provenance badge (touchpointSourceLabel) and the Send-to-NeoDove button both
// use sky, and a lead that shows a green chip here and a sky one on its own
// timeline reads as two different integrations.

import { isNeodoveLinked, neodoveTagTitle } from "@/lib/neodove/syncStatus";

export function NeodoveTag({
    syncStatus,
    className = "",
}: {
    /** `dealer_leads.neodove_sync_status`. */
    syncStatus: string | null | undefined;
    className?: string;
}) {
    if (!isNeodoveLinked(syncStatus)) return null;

    return (
        <span
            title={neodoveTagTitle(syncStatus)}
            className={`inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 ${className}`}
        >
            <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${
                    syncStatus === "priority_dial" ? "bg-amber-500" : "bg-sky-500"
                }`}
            />
            NeoDove
        </span>
    );
}
