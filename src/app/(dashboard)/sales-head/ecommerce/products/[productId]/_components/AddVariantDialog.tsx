"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupeesToMinor } from "@/lib/ecommerce/format";
import type { EcommerceOption } from "@/lib/ecommerce/types";

export function AddVariantDialog({
    productId,
    existingOptions,
    currency,
    onClose,
    onAdded,
}: {
    productId: string;
    existingOptions: EcommerceOption[];
    currency: string;
    onClose: () => void;
    onAdded: () => void;
}) {
    // A value must be given for EVERY option the product already has — a partial
    // combination is rejected 422 upstream.
    const [values, setValues] = useState<Record<string, string>>(
        Object.fromEntries(existingOptions.map((o) => [o.name, ""])),
    );
    const [newName, setNewName] = useState("");
    const [newValue, setNewValue] = useState("");
    const [sku, setSku] = useState("");
    const [priceInput, setPriceInput] = useState("");
    const [discountInput, setDiscountInput] = useState("");
    const [qty, setQty] = useState("");
    const [track, setTrack] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const priceMinor = useMemo(() => rupeesToMinor(priceInput), [priceInput]);
    const discountMinor = useMemo(() => rupeesToMinor(discountInput), [discountInput]);

    const addingDimension = newName.trim().length > 0 && newValue.trim().length > 0;
    const allExistingFilled = existingOptions.every((o) => (values[o.name] ?? "").trim());
    const hasAnyOption = existingOptions.length > 0 || addingDimension;

    const discountInvalid = discountInput.trim() !== "" && discountMinor === null;
    const discountTooHigh =
        discountMinor !== null && priceMinor !== null && discountMinor >= priceMinor;
    const qtyInvalid = qty.trim() !== "" && !/^\d+$/.test(qty.trim());
    const trackNeedsQty = track && qty.trim() === "";

    const canSubmit =
        hasAnyOption &&
        allExistingFilled &&
        !discountInvalid &&
        !discountTooHigh &&
        !qtyInvalid &&
        !trackNeedsQty &&
        !busy;

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const options = [
                ...existingOptions.map((o) => ({ name: o.name, value: values[o.name].trim() })),
                ...(addingDimension ? [{ name: newName.trim(), value: newValue.trim() }] : []),
            ];
            const res = await fetch(`/api/ecommerce/products/${productId}/variants`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    options,
                    ...(sku.trim() ? { sku: sku.trim() } : {}),
                    ...(priceMinor !== null ? { amountMinor: priceMinor, currency } : {}),
                    ...(discountMinor !== null ? { saleAmountMinor: discountMinor } : {}),
                    ...(qty.trim() ? { quantity: Number(qty.trim()) } : {}),
                    ...(track ? { manageInventory: true } : {}),
                }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error?.message ?? "Could not create the variant");
            onAdded();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not create the variant");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-card">
                <div className="flex items-start justify-between gap-3">
                    <h2 className="text-lg font-semibold text-ink">Add variant</h2>
                    <button onClick={onClose} className="text-ink-muted hover:text-ink" aria-label="Close">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {existingOptions.length ? (
                    <div className="space-y-3">
                        <p className="text-xs text-ink-muted">
                            Give a value for every option this product has — Hostinger rejects
                            partial combinations.
                        </p>
                        {existingOptions.map((o) => (
                            <div key={o.name} className="space-y-1.5">
                                <Label htmlFor={`opt-${o.name}`}>{o.name}</Label>
                                <Input
                                    id={`opt-${o.name}`}
                                    value={values[o.name] ?? ""}
                                    list={`sel-${o.name}`}
                                    onChange={(e) =>
                                        setValues((v) => ({ ...v, [o.name]: e.target.value }))
                                    }
                                    placeholder={o.selections[0] ?? ""}
                                />
                                <datalist id={`sel-${o.name}`}>
                                    {o.selections.map((s) => (
                                        <option key={s} value={s} />
                                    ))}
                                </datalist>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="rounded-lg bg-bg/50 px-3 py-2 text-xs text-ink-muted">
                        This product has no options yet. Naming one below creates it — and since a
                        SKU can only ever be set on a variant, this is the point at which SKUs
                        become possible for this product.
                    </p>
                )}

                <div className="space-y-2 rounded-lg border border-border px-3 py-3">
                    <p className="text-xs font-semibold text-ink">
                        {existingOptions.length ? "Add a new option dimension (optional)" : "Option"}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            placeholder="Option name, e.g. Size"
                        />
                        <Input
                            value={newValue}
                            onChange={(e) => setNewValue(e.target.value)}
                            placeholder="Selection, e.g. M"
                        />
                    </div>
                    {existingOptions.length > 0 && addingDimension ? (
                        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg/60 px-3 py-2 text-xs text-ink">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                            <span>
                                Adding <strong>{newName.trim()}</strong> rewrites every existing
                                variant, giving each one <strong>&quot;Default Value&quot;</strong>{" "}
                                for it. This cannot be undone — Hostinger has no way to rename or
                                remove an option.
                            </span>
                        </div>
                    ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="v-sku">SKU</Label>
                        <Input id="v-sku" value={sku} maxLength={255} onChange={(e) => setSku(e.target.value)} />
                        <p className="text-xs text-ink-muted">
                            Set it now — Hostinger cannot change a SKU once the variant exists.
                        </p>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="v-price">Price (INR)</Label>
                        <Input id="v-price" value={priceInput} inputMode="decimal" onChange={(e) => setPriceInput(e.target.value)} />
                        <p className="text-xs text-ink-muted">
                            {priceMinor !== null ? (
                                <>Will send <span className="font-mono text-ink">{priceMinor}</span> paise.</>
                            ) : (
                                "Up to 2 decimals."
                            )}
                        </p>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="v-disc">Discount price (INR)</Label>
                        <Input id="v-disc" value={discountInput} inputMode="decimal" onChange={(e) => setDiscountInput(e.target.value)} />
                        <p className="text-xs text-ink-muted">
                            {discountInvalid ? (
                                <span className="text-danger">Not a valid amount.</span>
                            ) : discountTooHigh ? (
                                <span className="text-danger">Must be lower than the price.</span>
                            ) : (
                                "Optional."
                            )}
                        </p>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="v-qty">Quantity</Label>
                        <Input id="v-qty" value={qty} inputMode="numeric" onChange={(e) => setQty(e.target.value)} />
                        <label className="flex items-center gap-2 text-sm text-ink">
                            <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
                            Track quantity
                        </label>
                        {trackNeedsQty ? (
                            <p className="text-xs text-danger">
                                Tracking needs a starting quantity, or the variant publishes as out
                                of stock.
                            </p>
                        ) : null}
                    </div>
                </div>

                {error ? (
                    <div className="flex items-start gap-2 rounded-lg bg-danger-bg/50 px-3 py-2 text-sm text-danger">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        {error}
                    </div>
                ) : null}

                <div className="flex gap-2">
                    <Button disabled={!canSubmit} onClick={submit}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create variant"}
                    </Button>
                    <Button variant="outline" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                </div>
            </div>
        </div>
    );
}
