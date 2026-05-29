// Inline banner shown when a mutate returned STALE_LEAD (BRD §0.3). Tells
// the rep who modified the lead and offers a refresh.

import { AlertOctagon, RefreshCw } from "lucide-react";

type Props = {
    onRefresh: () => void;
    currentOwnerName?: string | null;
    currentUpdatedAt?: string | null;
};

export function ConcurrencyBanner({ onRefresh, currentOwnerName, currentUpdatedAt }: Props) {
    return (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
            <AlertOctagon className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-amber-900">Lead changed by someone else</div>
                <div className="text-xs text-amber-800 mt-0.5">
                    {currentOwnerName ? `Current owner: ${currentOwnerName}. ` : ""}
                    {currentUpdatedAt
                        ? `Last updated ${new Date(currentUpdatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}. `
                        : ""}
                    Please coordinate before retrying.
                </div>
            </div>
            <button
                type="button"
                onClick={onRefresh}
                className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-amber-900 bg-white border border-amber-200 rounded-md px-2.5 py-1 hover:bg-amber-100"
            >
                <RefreshCw className="h-3 w-3" />
                Refresh
            </button>
        </div>
    );
}
