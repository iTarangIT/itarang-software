"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "../Modal";
import { FileUploadField } from "../FileUploadField";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type {
    AssetType,
    CommercialsProductLine,
    LeadDetailCommercials,
    ProductMasterOption,
    ProductMasterResponse,
} from "@/lib/inside-sales/types";

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

const ASSET_TYPES: { key: AssetType; label: string }[] = [
    { key: "battery", label: "Battery" },
    { key: "charger", label: "Charger" },
    { key: "paraphernalia", label: "Paraphernalia" },
];

const assetLabel = (t: AssetType) =>
    ASSET_TYPES.find((a) => a.key === t)?.label ?? t;

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

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
    const [quoteFileName, setQuoteFileName] = useState("");
    const [brochureUrl, setBrochureUrl] = useState(currentCommercials?.brochure_url ?? "");
    const [brochureFileName, setBrochureFileName] = useState("");
    const [dealNotes, setDealNotes] = useState(currentCommercials?.deal_notes ?? "");
    const [notes, setNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // ── Product line-items (E-128) ─────────────────────────────────────────
    const [lines, setLines] = useState<CommercialsProductLine[]>(
        currentCommercials?.product_lines ?? [],
    );
    const [products, setProducts] = useState<ProductMasterResponse | null>(null);
    const [productsState, setProductsState] = useState<"idle" | "loading" | "error">("idle");
    const [pickAssetType, setPickAssetType] = useState<AssetType>("battery");
    const [pickProductId, setPickProductId] = useState("");
    const [pickQty, setPickQty] = useState("1");

    // Load the product master once, when the modal first opens. A ref guards
    // against re-fetching — note we deliberately do NOT use a cancellation
    // flag here: the setState it triggers would re-run this effect, run the
    // prior cleanup, and cancel its own still-in-flight request.
    const productsRequested = useRef(false);
    useEffect(() => {
        if (!open || productsRequested.current) return;
        productsRequested.current = true;
        setProductsState("loading");
        (async () => {
            try {
                const res = await fetch("/api/inside-sales/products");
                const json = await res.json();
                if (!res.ok || !json?.success) {
                    throw new Error(json?.error?.message ?? "Failed to load products");
                }
                setProducts(json.data as ProductMasterResponse);
                setProductsState("idle");
            } catch {
                setProductsState("error");
                productsRequested.current = false; // allow a retry on reopen
            }
        })();
    }, [open]);

    const options: ProductMasterOption[] = useMemo(
        () => (products ? products[pickAssetType] : []),
        [products, pickAssetType],
    );
    const pickedOption = options.find((o) => o.id === pickProductId) ?? null;
    const linesSubtotal = lines.reduce(
        (sum, l) => sum + (l.unit_price != null ? l.unit_price * l.quantity : 0),
        0,
    );

    const handleClose = () => {
        if (submitting) return;
        onClose();
    };

    const addLine = () => {
        if (!pickedOption) {
            toast.error("Pick a product to add.");
            return;
        }
        const qty = Math.floor(Number(pickQty));
        if (!Number.isFinite(qty) || qty < 1) {
            toast.error("Enter a valid quantity.");
            return;
        }
        if (pickedOption.max_quantity != null && qty > pickedOption.max_quantity) {
            toast.error(`Max ${pickedOption.max_quantity} per lead for ${pickedOption.label}.`);
            return;
        }
        setLines((prev) => {
            const idx = prev.findIndex(
                (l) => l.asset_type === pickAssetType && l.product_id === pickedOption.id,
            );
            if (idx >= 0) {
                const next = [...prev];
                next[idx] = { ...next[idx], quantity: next[idx].quantity + qty };
                return next;
            }
            return [
                ...prev,
                {
                    asset_type: pickAssetType,
                    product_id: pickedOption.id,
                    product_name: pickedOption.label,
                    model_id: pickedOption.model_id,
                    unit_price: pickedOption.unit_price,
                    quantity: qty,
                },
            ];
        });
        setPickProductId("");
        setPickQty("1");
    };

    const removeLine = (assetType: AssetType, productId: string) => {
        setLines((prev) =>
            prev.filter((l) => !(l.asset_type === assetType && l.product_id === productId)),
        );
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
            if (lines.length) body.product_lines = lines;
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
                </div>

                {/* ── Products (E-128) ─────────────────────────────────── */}
                <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                        <Label className="!mb-0">Products</Label>
                        <span className="text-xs text-gray-500">
                            {lines.length} item{lines.length === 1 ? "" : "s"}
                        </span>
                    </div>

                    {productsState === "error" ? (
                        <p className="text-sm text-red-600">
                            Could not load the product catalogue. You can still save —
                            describe products in the notes below.
                        </p>
                    ) : (
                        <div className="flex flex-wrap items-end gap-2">
                            <div className="w-32">
                                <Label className="text-[11px]">Type</Label>
                                <select
                                    className="mt-1 w-full rounded-md border border-gray-200 px-2 py-2 text-sm bg-white"
                                    value={pickAssetType}
                                    onChange={(e) => {
                                        setPickAssetType(e.target.value as AssetType);
                                        setPickProductId("");
                                    }}
                                >
                                    {ASSET_TYPES.map((a) => (
                                        <option key={a.key} value={a.key}>{a.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex-1 min-w-[180px]">
                                <Label className="text-[11px]">Product</Label>
                                <select
                                    className="mt-1 w-full rounded-md border border-gray-200 px-2 py-2 text-sm bg-white"
                                    value={pickProductId}
                                    onChange={(e) => setPickProductId(e.target.value)}
                                    disabled={productsState === "loading" || !products}
                                >
                                    <option value="">
                                        {productsState === "loading"
                                            ? "Loading…"
                                            : options.length
                                              ? "Select a product"
                                              : "No products available"}
                                    </option>
                                    {options.map((o) => (
                                        <option key={o.id} value={o.id}>
                                            {o.label}
                                            {o.detail ? ` · ${o.detail}` : ""}
                                            {o.unit_price != null ? ` · ${inr(o.unit_price)}` : ""}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="w-20">
                                <Label className="text-[11px]">Qty</Label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={pickedOption?.max_quantity ?? undefined}
                                    value={pickQty}
                                    onChange={(e) => setPickQty(e.target.value)}
                                    className="mt-1"
                                />
                            </div>
                            <Button type="button" variant="outline" onClick={addLine} disabled={!pickedOption} className="gap-1.5">
                                <Plus className="h-4 w-4" />
                                Add
                            </Button>
                        </div>
                    )}

                    {lines.length > 0 && (
                        <ul className="space-y-1.5">
                            {lines.map((ln) => (
                                <li
                                    key={`${ln.asset_type}-${ln.product_id}`}
                                    className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                                >
                                    <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                                        {assetLabel(ln.asset_type)}
                                    </span>
                                    <span className="flex-1 truncate font-medium text-gray-900">
                                        {ln.product_name}
                                        {ln.model_id ? (
                                            <span className="ml-1.5 text-xs font-normal text-gray-400">
                                                {ln.model_id}
                                            </span>
                                        ) : null}
                                    </span>
                                    <span className="shrink-0 tabular-nums text-gray-700">× {ln.quantity}</span>
                                    <span className="w-24 shrink-0 text-right tabular-nums text-gray-900">
                                        {ln.unit_price != null
                                            ? inr(ln.unit_price * ln.quantity)
                                            : "—"}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => removeLine(ln.asset_type, ln.product_id)}
                                        aria-label={`Remove ${ln.product_name}`}
                                        className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {linesSubtotal > 0 && (
                        <div className="flex items-center justify-end gap-2 text-sm">
                            <span className="text-gray-500">Priced subtotal</span>
                            <span className="font-semibold tabular-nums text-gray-900">{inr(linesSubtotal)}</span>
                        </div>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <FileUploadField
                        label="Quote document"
                        value={quoteUrl ?? ""}
                        fileName={quoteFileName}
                        folder="commercials"
                        disabled={submitting}
                        onChange={(url, name) => {
                            setQuoteUrl(url);
                            setQuoteFileName(name);
                        }}
                    />
                    <FileUploadField
                        label="Brochure"
                        value={brochureUrl ?? ""}
                        fileName={brochureFileName}
                        folder="commercials"
                        disabled={submitting}
                        onChange={(url, name) => {
                            setBrochureUrl(url);
                            setBrochureFileName(name);
                        }}
                    />
                </div>

                <div>
                    <Label>Deal notes (extra product/quantity context for onboarding)</Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[64px]"
                        value={dealNotes ?? ""}
                        onChange={(e) => setDealNotes(e.target.value)}
                        placeholder="Any context not captured by the product list above"
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
