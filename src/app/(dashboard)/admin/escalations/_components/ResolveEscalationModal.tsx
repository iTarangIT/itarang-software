"use client";

// BRD §0.6 — admin escalation resolution. Three actions; direct Mark-Lost is
// intentionally absent (admin reassigns first, then the owner marks Lost).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Repeat, CornerDownLeft, Ban } from "lucide-react";
import { Modal } from "@/app/(dashboard)/inside-sales/_components/Modal";
import { Button } from "@/components/ui/button";
import type { EscalationResolutionAction, UserOption } from "@/lib/admin/types";

type Props = {
    open: boolean;
    onClose: () => void;
    escalationId: string;
    onSuccess: () => void;
};

const ACTIONS: {
    value: EscalationResolutionAction;
    label: string;
    desc: string;
    icon: React.ComponentType<{ className?: string }>;
}[] = [
    {
        value: "reassign",
        label: "Reassign Lead",
        desc: "Transfer ownership to a different rep or ASM.",
        icon: Repeat,
    },
    {
        value: "returned",
        label: "Return to Owner with Guidance",
        desc: "Keep the current owner; record admin instructions.",
        icon: CornerDownLeft,
    },
    {
        value: "no_action",
        label: "Mark No Action",
        desc: "Close the escalation without changes (justification required).",
        icon: Ban,
    },
];

export function ResolveEscalationModal({
    open,
    onClose,
    escalationId,
    onSuccess,
}: Props) {
    const [action, setAction] = useState<EscalationResolutionAction>("reassign");
    const [targetUserId, setTargetUserId] = useState("");
    const [notes, setNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const usersQuery = useQuery<{ success: true; data: { users: UserOption[] } }>({
        queryKey: ["admin-user-options"],
        enabled: open,
        queryFn: async () => {
            const res = await fetch("/api/admin/users", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load users");
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
    });
    const users = usersQuery.data?.data.users ?? [];

    const notesValid = notes.trim().length >= 10;
    const canSubmit =
        notesValid && (action !== "reassign" || targetUserId) && !submitting;

    async function submit() {
        setSubmitting(true);
        try {
            const res = await fetch(
                `/api/admin/escalations/${escalationId}/resolve`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action,
                        resolution_notes: notes.trim(),
                        target_user_id:
                            action === "reassign" ? targetUserId : undefined,
                    }),
                },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to resolve");
            }
            toast.success("Escalation resolved.");
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
            title="Resolve Escalation"
            subtitle="BRD §0.6 — Reassign, Return, or Mark No Action"
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
                        const active = action === a.value;
                        return (
                            <button
                                key={a.value}
                                type="button"
                                onClick={() => setAction(a.value)}
                                className={`w-full text-left rounded-lg border p-3 flex items-start gap-3 transition ${
                                    active
                                        ? "border-warning bg-warning-bg"
                                        : "border-border hover:bg-bg"
                                }`}
                            >
                                <a.icon
                                    className={`h-4 w-4 mt-0.5 shrink-0 ${
                                        active ? "text-warning" : "text-ink-muted"
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

                {action === "reassign" && (
                    <div>
                        <label className="block text-xs font-medium text-ink-muted mb-1">
                            Reassign to
                        </label>
                        <select
                            value={targetUserId}
                            onChange={(e) => setTargetUserId(e.target.value)}
                            className="w-full h-9 rounded-md border border-border px-2 text-sm"
                        >
                            <option value="">Select a rep or ASM…</option>
                            {users.map((u) => (
                                <option key={u.user_id} value={u.user_id}>
                                    {u.name ?? u.email} ({u.role})
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        Resolution notes{" "}
                        <span className="text-ink-muted">(min 10 characters)</span>
                    </label>
                    <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows={4}
                        placeholder="What you decided and why — visible to the owner and in the touchpoint history."
                        className="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-100"
                    />
                    {!notesValid && notes.length > 0 && (
                        <p className="mt-1 text-[11px] text-danger">
                            At least 10 characters required.
                        </p>
                    )}
                </div>
            </div>
        </Modal>
    );
}
