"use client";

// BRD §0.13 Point B — resolve an onboarding dropout: Keep Converted, Flip to
// Lost, or Re-engage. Reason + notes are mandatory for all three.

import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react";
import { Modal } from "@/app/(dashboard)/inside-sales/_components/Modal";
import { Button } from "@/components/ui/button";
import {
    ONBOARDING_DROPOUT_REASONS,
    type DropoutResolutionAction,
    type OnboardingDropoutRow,
} from "@/lib/admin/types";

type Props = {
    open: boolean;
    dropout: OnboardingDropoutRow;
    onClose: () => void;
    onSuccess: () => void;
};

const ACTIONS: {
    value: DropoutResolutionAction;
    label: string;
    desc: string;
    icon: React.ComponentType<{ className?: string }>;
}[] = [
    {
        value: "keep_converted",
        label: "Keep Converted",
        desc: "Deal stays won; record the dropout cause for tracking.",
        icon: CheckCircle2,
    },
    {
        value: "flip_to_lost",
        label: "Flip to Lost",
        desc: "Mark Lost with reason onboarding_dropout.",
        icon: XCircle,
    },
    {
        value: "re_engage",
        label: "Re-engage",
        desc: "Reopen the lead for a fresh sales cycle.",
        icon: RotateCcw,
    },
];

export function ResolveDropoutModal({
    open,
    dropout,
    onClose,
    onSuccess,
}: Props) {
    const [action, setAction] =
        useState<DropoutResolutionAction>("keep_converted");
    const [reason, setReason] = useState<string>(ONBOARDING_DROPOUT_REASONS[0]);
    const [notes, setNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const canSubmit = notes.trim().length >= 5 && !submitting;

    async function submit() {
        setSubmitting(true);
        try {
            const res = await fetch(
                `/api/admin/onboarding-dropouts/${dropout.id}/resolve`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action,
                        onboarding_dropout_reason: reason,
                        onboarding_dropout_notes: notes.trim(),
                    }),
                },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to resolve");
            }
            toast.success("Onboarding dropout resolved.");
            onSuccess();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            title="Resolve Onboarding Dropout"
            subtitle={dropout.dealer_name ?? dropout.id}
            width="md"
            footer={
                <>
                    <Button type="button" variant="outline" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        onClick={submit}
                        disabled={!canSubmit}
                    >
                        {submitting && (
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        )}
                        Resolve
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <div className="space-y-2">
                    {ACTIONS.map((a) => {
                        const activeOn = action === a.value;
                        return (
                            <button
                                key={a.value}
                                type="button"
                                onClick={() => setAction(a.value)}
                                className={`w-full text-left rounded-lg border p-3 flex items-start gap-3 transition ${
                                    activeOn
                                        ? "border-brand-400 bg-brand-50"
                                        : "border-border hover:bg-bg"
                                }`}
                            >
                                <a.icon
                                    className={`h-4 w-4 mt-0.5 shrink-0 ${
                                        activeOn ? "text-brand-700" : "text-ink-muted"
                                    }`}
                                />
                                <div>
                                    <div className="text-sm font-semibold text-ink">
                                        {a.label}
                                    </div>
                                    <div className="text-xs text-ink-muted">
                                        {a.desc}
                                    </div>
                                </div>
                            </button>
                        );
                    })}
                </div>

                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        Dropout reason
                    </label>
                    <select
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="w-full h-9 rounded-md border border-border px-2 text-sm"
                    >
                        {ONBOARDING_DROPOUT_REASONS.map((r) => (
                            <option key={r} value={r}>
                                {r.replace(/_/g, " ")}
                            </option>
                        ))}
                    </select>
                </div>

                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        Notes <span className="text-ink-muted">(required)</span>
                    </label>
                    <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows={3}
                        placeholder="What happened with onboarding and why this decision."
                        className="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-100"
                    />
                </div>
            </div>
        </Modal>
    );
}
