"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { Modal } from "../Modal";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    onSuccess: () => void;
};

export function MarkConvertedModal({ open, onClose, leadId, onSuccess }: Props) {
    const router = useRouter();
    const [notes, setNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        setSubmitting(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/mark-converted`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ notes: notes.trim() || null }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to mark converted");
            setNotes("");
            onSuccess();
            // BRD §0.13 — converting starts dealer onboarding: take the rep
            // straight into the wizard, pre-filled from this lead.
            const appId = json?.data?.onboardingApplicationId;
            if (appId) {
                toast.success("Lead Converted — starting dealer onboarding…");
                router.push(`/dealer-onboarding?applicationId=${encodeURIComponent(appId)}`);
            } else {
                toast.success("Lead marked Converted.");
            }
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            open={open}
            onClose={() => !submitting && onClose()}
            title="Mark Converted"
            width="sm"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
                    <Button
                        type="button"
                        onClick={submit}
                        disabled={submitting}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                        {submitting ? "Saving…" : "Mark Converted"}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 h-10 w-10 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
                        <CheckCircle2 className="h-5 w-5" />
                    </div>
                    <div className="space-y-1 text-sm text-gray-700">
                        <p>Marks the lead as <span className="font-semibold">Converted</span> (closing_owner_id = you) and initiates dealer onboarding.</p>
                        <p className="text-xs text-gray-500">
                            A draft dealer onboarding application is created automatically and linked to this lead. If it cannot be created, the conversion is rolled back.
                        </p>
                    </div>
                </div>
                <div>
                    <Label>Conversion notes (optional)</Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[64px]"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                    />
                </div>
            </div>
        </Modal>
    );
}
