"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Globe, MessageCircle } from "lucide-react";
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
    // After a successful conversion we keep the modal open on a "choose channel"
    // step so the rep can pick web wizard vs WhatsApp onboarding.
    const [appId, setAppId] = useState<string | null>(null);
    const [waSending, setWaSending] = useState(false);
    // Selected onboarding channel — picking an option only highlights it; the
    // rep must press Confirm to actually start onboarding (avoids instant kickoff
    // on a stray click).
    const [channel, setChannel] = useState<"web" | "whatsapp" | null>(null);

    const reset = () => {
        setNotes("");
        setAppId(null);
        setChannel(null);
    };

    const handleClose = () => {
        if (submitting || waSending) return;
        const wasConverted = Boolean(appId);
        reset();
        // Once converted, closing should refresh the lead (now Converted); before
        // conversion it's a plain cancel.
        if (wasConverted) onSuccess();
        else onClose();
    };

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
            // BRD §0.13 — converting starts dealer onboarding. Instead of forcing
            // the web wizard, let the rep choose the onboarding channel. We defer
            // onSuccess() (which closes + refreshes) until the rep picks a channel
            // or closes, so the choice step can render.
            const id = json?.data?.onboardingApplicationId;
            if (id) {
                toast.success("Lead Converted — choose how to onboard the dealer.");
                setAppId(id);
            } else {
                toast.success("Lead marked Converted.");
                onSuccess();
            }
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    const startWebOnboarding = () => {
        if (!appId) return;
        router.push(`/dealer-onboarding?applicationId=${encodeURIComponent(appId)}`);
    };

    const startWhatsAppOnboarding = async () => {
        setWaSending(true);
        try {
            const res = await fetch(
                `/api/inside-sales/lead/${encodeURIComponent(leadId)}/whatsapp-onboarding`,
                { method: "POST", headers: { "Content-Type": "application/json" } },
            );
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to start WhatsApp onboarding");
            if (json?.data?.delivered) {
                toast.success("WhatsApp onboarding invite sent to the dealer.");
            } else {
                toast.warning(
                    "Onboarding set up, but the WhatsApp invite couldn't be delivered (the dealer's 24-hour window may be closed). They can message us to begin.",
                );
            }
            reset();
            onSuccess();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setWaSending(false);
        }
    };

    const confirmChannel = () => {
        if (waSending) return;
        if (channel === "web") startWebOnboarding();
        else if (channel === "whatsapp") startWhatsAppOnboarding();
    };

    const inChoice = Boolean(appId);

    return (
        <Modal
            open={open}
            onClose={handleClose}
            title={inChoice ? "Start dealer onboarding" : "Mark Converted"}
            width="sm"
            closeOnBackdrop={!submitting && !waSending}
            footer={
                inChoice ? (
                    <>
                        <Button type="button" variant="outline" onClick={handleClose} disabled={waSending}>
                            Later
                        </Button>
                        <Button
                            type="button"
                            onClick={confirmChannel}
                            disabled={waSending || !channel}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                            {waSending ? "Starting…" : "Confirm"}
                        </Button>
                    </>
                ) : (
                    <>
                        <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>Cancel</Button>
                        <Button
                            type="button"
                            onClick={submit}
                            disabled={submitting}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                            {submitting ? "Saving…" : "Mark Converted"}
                        </Button>
                    </>
                )
            }
        >
            {inChoice ? (
                <div className="space-y-4">
                    <p className="text-sm text-gray-700">
                        The lead is <span className="font-semibold">Converted</span> and a draft
                        onboarding application is ready. Pick a channel and press
                        <span className="font-semibold"> Confirm</span> to start onboarding.
                    </p>
                    <div className="grid gap-3">
                        <button
                            type="button"
                            onClick={() => setChannel("web")}
                            disabled={waSending}
                            aria-pressed={channel === "web"}
                            className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
                                channel === "web"
                                    ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500"
                                    : "border-gray-200 hover:border-brand-300 hover:bg-brand-50/40"
                            }`}
                        >
                            <span className="shrink-0 h-10 w-10 rounded-lg bg-brand-100 text-brand-600 flex items-center justify-center">
                                <Globe className="h-5 w-5" />
                            </span>
                            <span className="text-sm">
                                <span className="block font-semibold text-gray-900">Web onboarding</span>
                                <span className="text-xs text-gray-500">Open the onboarding wizard now and fill it in yourself.</span>
                            </span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setChannel("whatsapp")}
                            disabled={waSending}
                            aria-pressed={channel === "whatsapp"}
                            className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
                                channel === "whatsapp"
                                    ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500"
                                    : "border-gray-200 hover:border-emerald-300 hover:bg-emerald-50/40"
                            }`}
                        >
                            <span className="shrink-0 h-10 w-10 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
                                <MessageCircle className="h-5 w-5" />
                            </span>
                            <span className="text-sm">
                                <span className="block font-semibold text-gray-900">WhatsApp onboarding</span>
                                <span className="text-xs text-gray-500">Invite the dealer to complete onboarding over WhatsApp.</span>
                            </span>
                        </button>
                    </div>
                </div>
            ) : (
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
            )}
        </Modal>
    );
}
