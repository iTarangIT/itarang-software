"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { minorToRupees, rupeesToMinor } from "@/lib/ecommerce/format";
import type { EcommerceProductDetail } from "@/lib/ecommerce/types";

type Status = "draft" | "published" | "archived";
/**
 * Archiving is deliberately NOT offered here. It is a lifecycle action with its
 * own confirmation on the product page, rather than something that happens as a
 * side effect of saving an unrelated edit. This form handles routine
 * draft <-> published only.
 */
const SETTABLE: Status[] = ["draft", "published"];

export function EditProductForm({ productId }: { productId: string }) {
    const router = useRouter();
    const [name, setName] = useState("");
    const [status, setStatus] = useState<Status | "">("");
    const [priceInput, setPriceInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState<string | null>(null);

    const query = useQuery<{ success: true; data: EcommerceProductDetail }>({
        queryKey: ["ecommerce-product", productId],
        queryFn: async () => {
            const res = await fetch(`/api/ecommerce/products/${productId}`, { cache: "no-store" });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message ?? "Failed to load product");
            }
            return res.json();
        },
    });

    const p = query.data?.data;
    const variant = p?.variants?.[0];

    useEffect(() => {
        if (!p) return;
        setName(p.title);
        // Only seed the dropdown when the current status is one we can actually
        // set — the API returns `proposed`/`rejected` but will not accept them.
        setStatus(SETTABLE.includes(p.status as Status) ? (p.status as Status) : "");
        if (variant?.price?.amountMinor != null) {
            setPriceInput(minorToRupees(variant.price.amountMinor, variant.price.currencyCode));
        }
    }, [p, variant]);

    const priceMinor = useMemo(() => rupeesToMinor(priceInput), [priceInput]);
    const priceChanged =
        priceMinor !== null && variant?.price?.amountMinor != null &&
        priceMinor !== variant.price.amountMinor;
    const detailsChanged = !!p && (name.trim() !== p.title || (status && status !== p.status));

    async function save() {
        if (!p) return;
        setBusy(true);
        setError(null);
        setSaved(null);
        const done: string[] = [];
        try {
            if (detailsChanged) {
                const res = await fetch(`/api/ecommerce/products/${productId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...(name.trim() !== p.title ? { name: name.trim() } : {}),
                        ...(status && status !== p.status ? { status } : {}),
                    }),
                });
                const body = await res.json().catch(() => null);
                if (!res.ok) throw new Error(body?.error?.message ?? "Update failed");
                done.push("details");
            }

            if (priceChanged && variant) {
                const res = await fetch(`/api/ecommerce/products/${productId}/price`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        variantId: variant.id,
                        amountMinor: priceMinor,
                        currency: variant.price?.currencyCode ?? "inr",
                    }),
                });
                const body = await res.json().catch(() => null);
                if (!res.ok) {
                    // Details may already have been saved above; say which parts
                    // landed rather than implying nothing changed.
                    throw new Error(
                        `${body?.error?.message ?? "Price update failed"}${
                            done.length ? ` (details were already saved)` : ""
                        }`,
                    );
                }
                done.push("price");
            }

            setSaved(done.length ? `Saved: ${done.join(" and ")}.` : "Nothing to save.");
            await query.refetch();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Save failed");
        } finally {
            setBusy(false);
        }
    }

    if (query.isLoading) {
        return (
            <div className="rounded-xl border border-border bg-surface p-12 text-center shadow-card">
                <Loader2 className="mx-auto h-5 w-5 animate-spin text-ink-muted" />
            </div>
        );
    }

    if (query.error || !p) {
        return (
            <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-bg/50 px-4 py-6 text-sm text-danger">
                <AlertTriangle className="h-4 w-4" />
                {(query.error as Error)?.message ?? "Product not found"}
            </div>
        );
    }

    return (
        <div className="space-y-5 rounded-xl border border-border bg-surface p-5 shadow-card">
            <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                    id="name"
                    value={name}
                    maxLength={255}
                    onChange={(e) => setName(e.target.value)}
                />
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="status">Status</Label>
                <select
                    id="status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as Status)}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
                >
                    {status === "" ? (
                        <option value="">{p.status ?? "unknown"} (read-only state)</option>
                    ) : null}
                    {SETTABLE.map((s) => (
                        <option key={s} value={s}>
                            {s}
                        </option>
                    ))}
                </select>
                {status === "" ? (
                    <p className="text-xs text-ink-muted">
                        Hostinger reports this product as <strong>{p.status}</strong>, which is not
                        a status the API allows setting. Choosing another value will change it
                        permanently.
                    </p>
                ) : null}
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="price">Price (INR)</Label>
                <Input
                    id="price"
                    value={priceInput}
                    inputMode="decimal"
                    disabled={!variant}
                    onChange={(e) => setPriceInput(e.target.value)}
                />
                <p className="text-xs text-ink-muted">
                    {!variant ? (
                        "No variant to price."
                    ) : priceMinor === null ? (
                        <span className="text-danger">
                            Not a valid amount — must be positive with at most 2 decimals.
                        </span>
                    ) : priceChanged ? (
                        <>
                            Will send <span className="font-mono text-ink">{priceMinor}</span> paise
                            (was {variant.price?.amountMinor}). Stock is not touched.
                        </>
                    ) : (
                        <>
                            Unchanged (<span className="font-mono">{variant.price?.amountMinor}</span>{" "}
                            paise).
                        </>
                    )}
                </p>
            </div>

            <div className="rounded-lg border border-border bg-bg/40 px-4 py-3 text-xs text-ink-muted">
                <strong className="text-ink">Description is not editable here.</strong> Hostinger
                can store a description but offers no way to read one back, so this form cannot
                show the current text — and saving a blank field would erase it. Edit descriptions
                in the Hostinger dashboard.
                <a
                    href={p.adminUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 inline-flex items-center gap-1 text-brand-700 hover:underline"
                >
                    Open there <ExternalLink className="h-3 w-3" />
                </a>
            </div>

            {error ? (
                <div className="flex items-center gap-2 rounded-lg bg-danger-bg/50 px-4 py-3 text-sm text-danger">
                    <AlertTriangle className="h-4 w-4" />
                    {error}
                </div>
            ) : null}
            {saved ? (
                <div className="rounded-lg bg-success-bg/60 px-4 py-3 text-sm text-success">{saved}</div>
            ) : null}

            <div className="flex gap-2">
                <Button disabled={busy || (!detailsChanged && !priceChanged)} onClick={save}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save changes"}
                </Button>
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => router.push(`/sales-head/ecommerce/products/${p.id}`)}
                >
                    Cancel
                </Button>
            </div>
        </div>
    );
}
