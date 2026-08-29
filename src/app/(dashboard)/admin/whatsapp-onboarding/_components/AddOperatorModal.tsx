"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AddOperatorModal({
    onClose,
    onAdded,
}: {
    onClose: () => void;
    onAdded: () => void;
}) {
    const [displayName, setDisplayName] = useState("");
    const [waPhone, setWaPhone] = useState("");
    const [email, setEmail] = useState("");
    const [notes, setNotes] = useState("");
    const [saving, setSaving] = useState(false);
    // Set after the API rejects a number that is already a dealer, so a second
    // submit is a deliberate confirmation rather than an accident.
    const [confirmDealer, setConfirmDealer] = useState(false);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setSaving(true);
        try {
            const res = await fetch("/api/admin/whatsapp-operators", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    displayName,
                    waPhone,
                    email: email || undefined,
                    notes: notes || undefined,
                    allowDealerNumber: confirmDealer,
                }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                // errorResponse() wraps the sentence as { error: { message } }.
                const message: string = json?.error?.message ?? "";
                if (res.status === 409 && /already belongs to dealer/i.test(message)) {
                    setConfirmDealer(true);
                }
                throw new Error(message || "Couldn't add this number");
            }
            toast.success(`${displayName} can now onboard dealers on WhatsApp`);
            onAdded();
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : "Couldn't add this number",
            );
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-surface shadow-xl">
                <div className="flex items-center justify-between border-b border-border px-5 py-3">
                    <h3 className="text-sm font-semibold text-ink">
                        Add an onboarding number
                    </h3>
                    <button
                        onClick={onClose}
                        className="text-ink-muted hover:text-ink"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <form onSubmit={submit} className="space-y-4 px-5 py-4">
                    <div className="space-y-1.5">
                        <Label htmlFor="op-name">Team member name</Label>
                        <Input
                            id="op-name"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder="Rahul Sharma"
                            required
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="op-phone">Their WhatsApp number</Label>
                        <Input
                            id="op-phone"
                            value={waPhone}
                            onChange={(e) => setWaPhone(e.target.value)}
                            placeholder="9876543210"
                            required
                        />
                        <p className="text-xs text-ink-muted">
                            This is the number they will chat from. They message
                            the iTarang business number as usual — nothing to set
                            up on their phone.
                        </p>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="op-email">Work email (optional)</Label>
                        <Input
                            id="op-email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="rahul@itarang.com"
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="op-notes">Notes (optional)</Label>
                        <Input
                            id="op-notes"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Field team — Pune"
                        />
                    </div>

                    {confirmDealer && (
                        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
                            This number already belongs to a dealer. Submitting
                            again adds it anyway — they&apos;ll reach their own
                            dealer console from the operator menu.
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={onClose}
                            disabled={saving}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving && (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            )}
                            {confirmDealer ? "Add anyway" : "Add number"}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
