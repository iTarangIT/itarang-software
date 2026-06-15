"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Props = {
    open: boolean;
    onClose: () => void;
    onSuccess: () => void;
};

const INTEREST = [
    { key: "hot", label: "Hot" },
    { key: "warm", label: "Warm" },
    { key: "cold", label: "Cold" },
] as const;

export function CreateLeadModal({ open, onClose, onSuccess }: Props) {
    const [dealerName, setDealerName] = useState("");
    const [shopName, setShopName] = useState("");
    const [phone, setPhone] = useState("");
    const [city, setCity] = useState("");
    const [state, setState] = useState("");
    const [interest, setInterest] = useState<"hot" | "warm" | "cold" | "">("");
    const [submitting, setSubmitting] = useState(false);

    const reset = () => {
        setDealerName("");
        setShopName("");
        setPhone("");
        setCity("");
        setState("");
        setInterest("");
    };

    const handleClose = () => {
        if (submitting) return;
        onClose();
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const phoneDigits = phone.replace(/\D/g, "");
        if (dealerName.trim().length < 2) {
            toast.error("Enter the dealer name.");
            return;
        }
        if (phoneDigits.length !== 10) {
            toast.error("Enter a valid 10-digit phone number.");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch("/api/inside-sales/lead/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    dealer_name: dealerName.trim(),
                    shop_name: shopName.trim() || null,
                    phone: phoneDigits,
                    city: city.trim() || null,
                    state: state.trim() || null,
                    interest_level: interest || null,
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to create lead");
            toast.success("Lead created — find it in the Unassigned (Claim) tab.");
            reset();
            onSuccess();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            open={open}
            onClose={handleClose}
            title="Create Lead"
            subtitle="Adds an unassigned lead to the claim queue"
            width="md"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>Cancel</Button>
                    <Button type="button" onClick={submit} disabled={submitting}>
                        {submitting ? "Creating…" : "Create Lead"}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <Label>Dealer name *</Label>
                    <Input value={dealerName} onChange={(e) => setDealerName(e.target.value)} className="mt-1" autoFocus />
                </div>
                <div>
                    <Label>Shop name</Label>
                    <Input value={shopName} onChange={(e) => setShopName(e.target.value)} className="mt-1" />
                </div>
                <div>
                    <Label>Phone *</Label>
                    <Input
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        inputMode="numeric"
                        placeholder="10-digit mobile"
                        className="mt-1"
                    />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <Label>City</Label>
                        <Input value={city} onChange={(e) => setCity(e.target.value)} className="mt-1" />
                    </div>
                    <div>
                        <Label>State</Label>
                        <Input value={state} onChange={(e) => setState(e.target.value)} className="mt-1" />
                    </div>
                </div>
                <div>
                    <Label>Interest level</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                        value={interest}
                        onChange={(e) => setInterest(e.target.value as "hot" | "warm" | "cold" | "")}
                    >
                        <option value="">—</option>
                        {INTEREST.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
                    </select>
                </div>
            </form>
        </Modal>
    );
}
