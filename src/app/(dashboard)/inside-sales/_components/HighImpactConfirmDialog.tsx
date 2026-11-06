// High-impact Lost reason confirmation (BRD §0.7). Explains the operational
// consequence and forces an explicit "Continue" before the parent submits.

import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import type { LostReason } from "@/lib/lifecycle/transitions";

const CONSEQUENCE: Partial<Record<LostReason, { title: string; body: string; tip?: string }>> = {
    business_closed: {
        title: "Permanent AI dialer exclusion",
        body: "The AI dialer will never call this number again.",
    },
    duplicate_lead: {
        title: "Merge review required",
        body: "This dealer already exists under another phone number.",
        tip: "Admin will review and merge the two leads' activity and quotes.",
    },
    rejected_by_us_credit: {
        title: "Credit rejection — archive recommended",
        body: "Our credit team rejected this dealer. We'll archive the lead.",
        tip: "Don't reactivate it unless the dealer's credit changes.",
    },
    rejected_by_us_geography: {
        title: "Out-of-service area — archive recommended",
        body: "We can't serve this dealer's area.",
        tip: "Don't reactivate it unless we start serving this area.",
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
            title="Mark this lead Lost?"
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
                        {loading ? "Saving…" : "Mark Lost"}
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
                    <p className="text-sm text-gray-700 leading-relaxed">
                        {consequence?.body}
                        {consequence?.tip ? (
                            <>
                                {" "}
                                <InfoTip>{consequence.tip}</InfoTip>
                            </>
                        ) : null}
                    </p>
                    <p className="text-xs text-gray-500 mt-3">
                        You can&apos;t undo this. Only Admin, the Sales Head or the CEO can reactivate a Lost lead.
                    </p>
                </div>
            </div>
        </Modal>
    );
}
