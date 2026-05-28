"use client";

// BRD §0.6 — CEO escalation advisory. The CEO can add a free-text comment
// and/or a structured recommendation on a pending escalation. CEO advises;
// admin executes — this modal never resolves the escalation.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquare, Sparkles } from "lucide-react";
import { Modal } from "@/app/(dashboard)/inside-sales/_components/Modal";
import { Button } from "@/components/ui/button";

type Props = {
    open: boolean;
    onClose: () => void;
    escalationId: string;
    existingComment?: string | null;
    onSuccess: () => void;
};

const RECO_OPTIONS = [
    { value: "reassign", label: "Recommend Reassign" },
    { value: "return", label: "Recommend Return with guidance" },
    { value: "no_action", label: "Recommend No Action" },
];

export function CeoAdvisoryModal({
    open,
    onClose,
    escalationId,
    existingComment,
    onSuccess,
}: Props) {
    const [comment, setComment] = useState(existingComment ?? "");
    const [recoType, setRecoType] = useState("reassign");
    const [recoText, setRecoText] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const commentChanged =
        comment.trim().length >= 5 &&
        comment.trim() !== (existingComment ?? "").trim();
    const hasReco = recoText.trim().length >= 5;
    const canSubmit = (commentChanged || hasReco) && !submitting;

    async function post(payload: Record<string, unknown>) {
        const res = await fetch(
            `/api/admin/escalations/${escalationId}/ceo-input`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
            throw new Error(json?.error?.message ?? "Failed to save advisory");
        }
    }

    async function submit() {
        setSubmitting(true);
        try {
            if (commentChanged) {
                await post({ action: "comment", text: comment.trim() });
            }
            if (hasReco) {
                await post({
                    action: "recommend",
                    recommendation: recoType,
                    text: recoText.trim(),
                });
            }
            toast.success("CEO advisory saved.");
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
            title="CEO Advisory"
            subtitle="BRD §0.6 — comment and/or recommend; the admin executes"
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
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        )}
                        Save Advisory
                    </Button>
                </>
            }
        >
            <div className="space-y-5">
                <div>
                    <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
                        <MessageSquare className="h-3.5 w-3.5" />
                        Comment
                        <span className="text-ink-muted/70">(optional)</span>
                    </label>
                    <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={3}
                        placeholder="Context or guidance for the admin reviewing this escalation."
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-brand-sky focus:outline-none focus:ring-4 focus:ring-brand-sky/15"
                    />
                </div>

                <div className="space-y-2 rounded-lg border border-border bg-bg/50 p-3">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
                        <Sparkles className="h-3.5 w-3.5" />
                        Recommendation
                        <span className="text-ink-muted/70">(optional)</span>
                    </label>
                    <select
                        value={recoType}
                        onChange={(e) => setRecoType(e.target.value)}
                        className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
                    >
                        {RECO_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                    <textarea
                        value={recoText}
                        onChange={(e) => setRecoText(e.target.value)}
                        rows={2}
                        placeholder="Who to reassign to / what guidance / why no action."
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-brand-sky focus:outline-none focus:ring-4 focus:ring-brand-sky/15"
                    />
                    <p className="text-[11px] text-ink-muted">
                        The admin sees this recommendation prominently but
                        decides whether to execute it.
                    </p>
                </div>
            </div>
        </Modal>
    );
}
