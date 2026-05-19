"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { LeadDetailCommercials } from "@/lib/inside-sales/types";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    currentCommercials: LeadDetailCommercials | null;
    onSuccess: () => void;
};

const EVENT_TYPES = [
    { key: "brochure_share", label: "Brochure share" },
    { key: "quote_issue", label: "Quote issued" },
    { key: "quote_revision", label: "Quote revision" },
    { key: "terms_update", label: "Terms update" },
    { key: "final_terms", label: "Final terms (sets final_price)" },
] as const;

type EventType = (typeof EVENT_TYPES)[number]["key"];

export function UpdateCommercialsModal({ open, onClose, leadId, currentCommercials, onSuccess }: Props) {
    const [eventType, setEventType] = useState<EventType>("quote_issue");
    const [priceQuoted, setPriceQuoted] = useState(currentCommercials?.price_quoted ?? "");
    const [finalPrice, setFinalPrice] = useState(currentCommercials?.final_price ?? "");
    const [paymentMethod, setPaymentMethod] = useState<"cash" | "finance" | "">(
        (currentCommercials?.payment_method as "cash" | "finance" | null) ?? "",
    );
    const [creditTerms, setCreditTerms] = useState(currentCommercials?.credit_terms ?? "");
    const [deliveryTerms, setDeliveryTerms] = useState(currentCommercials?.delivery_terms ?? "");
    const [warrantyTerms, setWarrantyTerms] = useState(currentCommercials?.warranty_terms ?? "");
    const [quoteUrl, setQuoteUrl] = useState(currentCommercials?.quote_document_url ?? "");
    const [brochureUrl, setBrochureUrl] = useState(currentCommercials?.brochure_url ?? "");
    const [dealNotes, setDealNotes] = useState(currentCommercials?.deal_notes ?? "");
    const [notes, setNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const handleClose = () => {
        if (submitting) return;
        onClose();
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            const body: Record<string, unknown> = { event_type: eventType };
            if (priceQuoted) body.price_quoted = Number(priceQuoted);
            if (finalPrice) body.final_price = Number(finalPrice);
            if (paymentMethod) body.payment_method = paymentMethod;
            if (creditTerms) body.credit_terms = creditTerms;
            if (deliveryTerms) body.delivery_terms = deliveryTerms;
            if (warrantyTerms) body.warranty_terms = warrantyTerms;
            if (quoteUrl) body.quote_document_url = quoteUrl;
            if (brochureUrl) body.brochure_url = brochureUrl;
            if (dealNotes) body.deal_notes = dealNotes;
            if (notes) body.notes = notes;

            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/commercials`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to update commercials");
            toast.success(`Commercials v${(currentCommercials?.version_no ?? 0) + 1} saved.`);
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
            title="Update Commercials"
            subtitle={
                currentCommercials
                    ? `Current: v${currentCommercials.version_no} · ${currentCommercials.event_type}`
                    : "First commercial event"
            }
            width="lg"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>Cancel</Button>
                    <Button type="button" onClick={submit} disabled={submitting}>
                        {submitting ? "Saving…" : "Save new version"}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <Label>Event type</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                        value={eventType}
                        onChange={(e) => setEventType(e.target.value as EventType)}
                    >
                        {EVENT_TYPES.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
                    </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <Label>Price quoted (₹)</Label>
                        <Input type="number" value={priceQuoted ?? ""} onChange={(e) => setPriceQuoted(e.target.value)} className="mt-1" />
                    </div>
                    <div>
                        <Label>Final price (₹) — gate for Mark Converted</Label>
                        <Input type="number" value={finalPrice ?? ""} onChange={(e) => setFinalPrice(e.target.value)} className="mt-1" />
                    </div>
                    <div>
                        <Label>Payment method</Label>
                        <select
                            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                            value={paymentMethod}
                            onChange={(e) => setPaymentMethod(e.target.value as "cash" | "finance" | "")}
                        >
                            <option value="">—</option>
                            <option value="cash">Cash</option>
                            <option value="finance">Finance</option>
                        </select>
                    </div>
                    <div>
                        <Label>Credit terms</Label>
                        <Input value={creditTerms ?? ""} onChange={(e) => setCreditTerms(e.target.value)} placeholder="e.g. 30 days" className="mt-1" />
                    </div>
                    <div>
                        <Label>Delivery terms</Label>
                        <Input value={deliveryTerms ?? ""} onChange={(e) => setDeliveryTerms(e.target.value)} placeholder="e.g. 15 days FOB Faridabad" className="mt-1" />
                    </div>
                    <div>
                        <Label>Warranty</Label>
                        <Input value={warrantyTerms ?? ""} onChange={(e) => setWarrantyTerms(e.target.value)} placeholder="e.g. 24 months" className="mt-1" />
                    </div>
                    <div className="col-span-2">
                        <Label>Quote document URL</Label>
                        <Input type="url" value={quoteUrl ?? ""} onChange={(e) => setQuoteUrl(e.target.value)} className="mt-1" placeholder="https://…" />
                    </div>
                    <div className="col-span-2">
                        <Label>Brochure URL</Label>
                        <Input type="url" value={brochureUrl ?? ""} onChange={(e) => setBrochureUrl(e.target.value)} className="mt-1" placeholder="https://…" />
                    </div>
                </div>
                <div>
                    <Label>Deal notes (product + quantity context for onboarding)</Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[64px]"
                        value={dealNotes ?? ""}
                        onChange={(e) => setDealNotes(e.target.value)}
                        placeholder="e.g. 100 units of E-Rick Pro 100Ah, including chargers"
                    />
                </div>
                <div>
                    <Label>Version notes (this commercial event)</Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[48px]"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                    />
                </div>
            </form>
        </Modal>
    );
}
