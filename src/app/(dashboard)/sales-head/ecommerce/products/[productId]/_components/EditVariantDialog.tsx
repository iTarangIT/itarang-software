"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { minorToRupees, rupeesToMinor } from "@/lib/ecommerce/format";
import type { EcommerceVariant } from "@/lib/ecommerce/types";

export function EditVariantDialog({
    productId,
    variant,
    onClose,
    onSaved,
}: {
    productId: string;
    variant: EcommerceVariant;
    onClose: () => void;
    onSaved: () => void;
}) {
    const currency = variant.price?.currencyCode ?? "inr";
    const [title, setTitle] = useState(variant.title);
    const [priceInput, setPriceInput] = useState(
        variant.price?.amountMinor != null ? minorToRupees(variant.price.amountMinor, currency) : "",
    );
    const [discountInput, setDiscountInput] = useState(
        variant.price?.saleAmountMinor != null
            ? minorToRupees(variant.price.saleAmountMinor, currency)
            : "",
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const priceMinor = useMemo(() => rupeesToMinor(priceInput), [priceInput]);
    const discountMinor = useMemo(() => rupeesToMinor(discountInput), [discountInput]);

    const currentDiscount = variant.price?.saleAmountMinor ?? null;
    const titleChanged = title.trim() !== variant.title && title.trim().length > 0;
    const priceChanged = priceMinor !== null && priceMinor !== variant.price?.amountMinor;
    const discountCleared = discountInput.trim() === "" && currentDiscount !== null;
    const discountChanged =
        discountCleared || (discountMinor !== null && discountMinor !== currentDiscount);

    const discountInvalid = discountInput.trim() !== "" && discountMinor === null;
    const discountTooHigh =
        discountMinor !== null && priceMinor !== null && discountMinor >= priceMinor;

    async function save() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/ecommerce/products/${productId}/variants/${variant.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...(titleChanged ? { title: title.trim() } : {}),
                    ...(priceChanged ? { amountMinor: priceMinor } : {}),
                    ...(discountChanged
                        ? { saleAmountMinor: discountCleared ? null : discountMinor }
                        : {}),
                    currency,
                }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error?.message ?? "Could not save the variant");
            onSaved();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save the variant");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-5 shadow-card">
                <div className="flex items-start justify-between gap-3">
                    <h2 className="text-lg font-semibold text-ink">Edit variant</h2>
                    <button onClick={onClose} className="text-ink-muted hover:text-ink" aria-label="Close">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <dl className="divide-y divide-border rounded-lg border border-border text-sm">
                    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
                        <dt className="text-ink-muted">Options</dt>
                        <dd className="text-ink">
                            {variant.options.length
                                ? variant.options.map((o) => `${o.name}: ${o.value}`).join(", ")
                                : "None"}
                        </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
                        <dt className="text-ink-muted">SKU</dt>
                        <dd className="font-mono text-xs text-ink">{variant.sku ?? "—"}</dd>
                    </div>
                </dl>
                <p className="-mt-2 text-[11px] text-ink-muted">
                    Options and SKU are fixed once a variant exists — the API rejects an options
                    change and silently ignores a SKU change, so neither is offered here. Replacing
                    them means creating a new variant and deleting this one.
                </p>

                <div className="space-y-1.5">
                    <Label htmlFor="ev-title">Title</Label>
                    <Input id="ev-title" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="ev-price">Price (INR)</Label>
                        <Input id="ev-price" value={priceInput} inputMode="decimal" onChange={(e) => setPriceInput(e.target.value)} />
                        <p className="text-xs text-ink-muted">
                            {priceMinor !== null ? (
                                <>Will send <span className="font-mono text-ink">{priceMinor}</span> paise.</>
                            ) : (
                                "Up to 2 decimals."
                            )}
                        </p>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="ev-disc">Discount price (INR)</Label>
                        <Input id="ev-disc" value={discountInput} inputMode="decimal" onChange={(e) => setDiscountInput(e.target.value)} />
                        <p className="text-xs text-ink-muted">
                            {discountInvalid ? (
                                <span className="text-danger">Not a valid amount.</span>
                            ) : discountTooHigh ? (
                                <span className="text-danger">Must be lower than the price.</span>
                            ) : discountCleared ? (
                                "Saving removes the discount."
                            ) : (
                                "Empty means no discount."
                            )}
                        </p>
                    </div>
                </div>

                <p className="text-[11px] text-ink-muted">
                    Stock is edited from this variant&apos;s Adjust stock action, so a price change
                    cannot disturb it.
                </p>

                {error ? (
                    <div className="flex items-start gap-2 rounded-lg bg-danger-bg/50 px-3 py-2 text-sm text-danger">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        {error}
                    </div>
                ) : null}

                <div className="flex gap-2">
                    <Button
                        disabled={
                            busy ||
                            discountInvalid ||
                            discountTooHigh ||
                            (!titleChanged && !priceChanged && !discountChanged)
                        }
                        onClick={save}
                    >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save variant"}
                    </Button>
                    <Button variant="outline" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                </div>
            </div>
        </div>
    );
}
