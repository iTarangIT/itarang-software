// Per-row "Send to NeoDove" trigger for the leads list.
//
// Deliberately thin: it owns nothing but the open/closed state of the modal,
// which is where the destination choice, the exclusion override and the
// "accepted != created" caveat all live. Modelled on CallButton's states, but
// note the outcome wording differs on purpose — CallButton says "Called!",
// while a NeoDove push can only honestly claim "Sent", because NeoDove
// acknowledges receipt without confirming the lead was created.

"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SendToNeodoveModal } from "@/components/leads/send-to-neodove-modal";

export function SendToNeodoveButton({
    leadId,
    leadName,
    disabled,
    syncStatus,
    onSent,
}: {
    leadId: string;
    leadName: string;
    disabled?: boolean;
    /**
     * `dealer_leads.neodove_sync_status` for this lead, from the list API.
     * Without it the button's memory lasted exactly as long as the component
     * did — a reload put an already-pushed lead back to "NeoDove", which reads
     * as "not sent yet" and invites a duplicate push.
     *
     * `failed` deliberately does NOT count as sent: that push was refused and
     * the lead should still be re-sendable. `inbound` does, because the lead
     * demonstrably exists in NeoDove — it came back from there.
     */
    syncStatus?: string | null;
    onSent?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [justSent, setJustSent] = useState(false);

    // Local state covers the gap between a successful push and the list's next
    // refetch; the persisted status covers every load after that.
    // `priority_dial` (E-226) counts as sent for the same reason `pushed` does:
    // the lead is already in NeoDove, and re-sending it would be refused as a
    // duplicate while looking to the operator like a fresh hand-off.
    const sent =
        justSent ||
        syncStatus === "pushed" ||
        syncStatus === "inbound" ||
        syncStatus === "priority_dial";

    return (
        <>
            <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen(true)}
                disabled={disabled}
                title={
                    sent
                        ? "Already handed to NeoDove — re-sending is refused as a duplicate"
                        : "Hand this lead to the NeoDove calling team"
                }
                className={`flex items-center gap-2 transition-all duration-200 ${
                    sent
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "text-sky-600 border-sky-200 hover:bg-sky-50"
                } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
            >
                <Send className="w-3.5 h-3.5" />
                {sent ? "Sent" : "NeoDove"}
            </Button>

            {open && (
                <SendToNeodoveModal
                    leadIds={[leadId]}
                    label={leadName}
                    onClose={() => setOpen(false)}
                    onSent={() => {
                        setJustSent(true);
                        onSent?.();
                    }}
                />
            )}
        </>
    );
}
