// High-impact Lost reason confirmation (BRD §0.7). Explains the operational
// consequence and forces an explicit "Continue" before the parent submits.

import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import type { LostReason } from "@/lib/lifecycle/transitions";

const CONSEQUENCE: Partial<Record<LostReason, { title: string; body: string }>> = {
    business_closed: {
        title: "Permanent AI dialer exclusion",
        body: "This will permanently exclude the phone from the AI dialer pool (ai_recall_status → excluded). The dealer cannot be re-engaged through AI calling.",
    },
    duplicate_lead: {
        title: "Merge review required",
        body: "This indicates the dealer exists under another phone in our system. A merge review will be required to consolidate touchpoints and commercials.",
    },
    rejected_by_us_credit: {
        title: "Credit rejection — archive recommended",
        body: "This signals our credit team rejected the dealer's profile. The lead will be archived; downstream reactivation is not recommended unless credit signals change.",
    },
    rejected_by_us_geography: {
        title: "Out-of-service area — archive recommended",
        body: "This signals we cannot serve this dealer's location. Reactivation is not recommended unless our service area expands.",
    },
};

type Props = {
    open: boolean;
    reason: LostReason | null;
    onCancel: () => void;
    onConfirm: () => void;
    loading?: boolean;
};

export function HighImpactConfirmDialog({ open, reason, onCancel, onConfirm, loading }: Props) {
    const consequence = reason ? CONSEQUENCE[reason] : null;
    return (
        <Modal
            open={open && Boolean(consequence)}
            onClose={onCancel}
            title="Confirm high-impact close"
            width="sm"
            closeOnBackdrop={!loading}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={onConfirm}
                        disabled={loading}
                        className="bg-rose-600 hover:bg-rose-700 text-white"
                    >
                        {loading ? "Saving…" : "Continue & Mark Lost"}
                    </Button>
                </>
            }
        >
            <div className="flex items-start gap-3">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-rose-100 text-rose-600 flex items-center justify-center">
                    <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-gray-900">{consequence?.title}</h3>
                    <p className="text-sm text-gray-700 leading-relaxed">{consequence?.body}</p>
                    <p className="text-xs text-gray-500 mt-3">
                        This action cannot be undone from the rep workspace. Admin can reactivate via the Lost lead reactivation flow.
                    </p>
                </div>
            </div>
        </Modal>
    );
}
