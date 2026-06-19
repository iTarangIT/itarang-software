"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/select-dropdown";
import type { RegionsResponse } from "@/app/api/locations/regions/route";

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
    // stateCode drives the dependent city list; the lead row stores the state
    // *name*, resolved at submit time from the loaded states list.
    const [stateCode, setStateCode] = useState("");
    const [city, setCity] = useState("");
    const [interest, setInterest] = useState<"hot" | "warm" | "cold" | "">("");
    const [submitting, setSubmitting] = useState(false);

    // Canonical state + city reference lists (E-108/E-110/E-111). Loaded once
    // when the modal first opens and cached by React Query.
    const { data: regions } = useQuery<RegionsResponse>({
        queryKey: ["locations-regions"],
        queryFn: async () => {
            const res = await fetch("/api/locations/regions", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load states/cities");
            const json = await res.json();
            return json.data as RegionsResponse;
        },
        enabled: open,
        staleTime: 60 * 60 * 1000,
    });

    const stateOptions = (regions?.states ?? []).map((s) => ({
        value: s.code,
        label: s.name,
    }));
    const cityOptions = (
        stateCode ? regions?.citiesByState[stateCode] ?? [] : []
    ).map((c) => ({ value: c, label: c }));
    const stateName =
        regions?.states.find((s) => s.code === stateCode)?.name ?? "";

    const reset = () => {
        setDealerName("");
        setShopName("");
        setPhone("");
        setStateCode("");
        setCity("");
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
                    city: city || null,
                    state: stateName || null,
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
                        <Label>State</Label>
                        <Dropdown
                            value={stateCode}
                            onChange={(v) => {
                                setStateCode(v);
                                // Reset city — its options depend on the state.
                                setCity("");
                            }}
                            options={stateOptions}
                            placeholder="Select state"
                            className="mt-1"
                        />
                    </div>
                    <div>
                        <Label>City</Label>
                        <Dropdown
                            value={city}
                            onChange={setCity}
                            options={cityOptions}
                            placeholder={stateCode ? "Select city" : "Pick a state first"}
                            disabled={!stateCode}
                            className="mt-1"
                        />
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
