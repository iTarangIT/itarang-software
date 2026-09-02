"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DealerOption } from "./MultiDealerNumbersView";

export function AddExtraNumberModal({
    dealers,
    initialDealerCode,
    onClose,
    onAdded,
}: {
    dealers: DealerOption[];
    initialDealerCode: string;
    onClose: () => void;
    onAdded: () => void;
}) {
    const [dealerCode, setDealerCode] = useState(initialDealerCode);
    const [displayName, setDisplayName] = useState("");
    const [waPhone, setWaPhone] = useState("");
    const [notes, setNotes] = useState("");
    const [saving, setSaving] = useState(false);

    const selectedDealer = dealers.find((d) => d.id === dealerCode) ?? null;

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!dealerCode) {
            toast.error("Select a dealer first");
            return;
        }
        setSaving(true);
        try {
            const res = await fetch("/api/admin/dealer-extra-numbers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    dealerCode,
                    displayName,
                    waPhone,
                    notes: notes || undefined,
                }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                // errorResponse() wraps the sentence as { error: { message } }.
                // Unlike the operator modal there is no confirm-override —
                // every conflict here is terminal.
                throw new Error(
                    json?.error?.message || "Couldn't add this number",
                );
            }
            toast.success(
                `${displayName} now acts as the main dealer on WhatsApp`,
            );
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
                        Add a main-dealer number
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
                        <Label htmlFor="xn-dealer">Dealer</Label>
                        <select
                            id="xn-dealer"
                            value={dealerCode}
                            onChange={(e) => setDealerCode(e.target.value)}
                            required
                            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm text-ink"
                        >
                            <option value="">Select a dealer…</option>
                            {dealers.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.business_entity_name || d.id}
                                    {d.city ? ` · ${d.city}` : ""}
                                </option>
                            ))}
                        </select>
                        {selectedDealer && !selectedDealer.has_login && (
                            <p className="text-xs text-warning">
                                This dealer has no portal login user — WhatsApp
                                lead creation from any of their numbers will not
                                work until one exists.
                            </p>
                        )}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="xn-name">Who uses this number?</Label>
                        <Input
                            id="xn-name"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder="Partner — Rakesh"
                            required
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="xn-phone">WhatsApp number</Label>
                        <Input
                            id="xn-phone"
                            value={waPhone}
                            onChange={(e) => setWaPhone(e.target.value)}
                            placeholder="9876543210"
                            required
                        />
                        <p className="text-xs text-ink-muted">
                            Messages from this number will open the dealer&apos;s
                            FULL console — customer leads it creates belong to
                            the dealer, exactly like their own number.
                        </p>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="xn-notes">Notes (optional)</Label>
                        <Input
                            id="xn-notes"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Second branch — Kochi"
                        />
                    </div>

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
                            Add number
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
