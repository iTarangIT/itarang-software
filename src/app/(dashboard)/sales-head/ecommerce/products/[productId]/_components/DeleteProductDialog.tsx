"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type DeleteResult = { productId: string; removed: boolean; survivingStatus?: string | null };

export function DeleteProductDialog({
    productId,
    productTitle,
    onClose,
}: {
    productId: string;
    productTitle: string;
    onClose: () => void;
}) {
    const router = useRouter();
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<DeleteResult | null>(null);

    // Typing the exact name, not a checkbox: this has no undo, and a checkbox is
    // too easy to click through.
    const matches = typed.trim() === productTitle.trim();

    async function remove() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/ecommerce/products/${productId}`, { method: "DELETE" });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error?.message ?? "Delete failed");
            setResult(body.data as DeleteResult);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Delete failed");
        } finally {
            setBusy(false);
        }
    }

    if (result) {
        return (
            <Shell onClose={onClose} title={result.removed ? "Product deleted" : "Product not deleted"}>
                {result.removed ? (
                    <p className="text-sm text-ink">
                        <span className="font-semibold">{productTitle}</span> was permanently
                        removed from Hostinger.
                    </p>
                ) : (
                    /* Hostinger archives a subscription product with active subscribers
                       instead of deleting it. Saying "deleted" would be untrue and would
                       send someone looking for a product that is still on the books. */
                    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg/60 px-3 py-3 text-sm text-ink">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                        <span>
                            Hostinger did <strong>not</strong> delete this product — it still
                            exists with status{" "}
                            <strong>{result.survivingStatus ?? "unknown"}</strong>. This happens
                            when a product cannot be removed, for example a subscription product
                            with active subscribers.
                        </span>
                    </div>
                )}
                <div className="flex gap-2">
                    <Button onClick={() => router.push("/sales-head/ecommerce/products")}>
                        Back to products
                    </Button>
                </div>
            </Shell>
        );
    }

    return (
        <Shell onClose={onClose} title="Delete product">
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-bg/50 px-3 py-3 text-sm text-ink">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <span>
                    This permanently removes the product and its variants from Hostinger.{" "}
                    <strong>It cannot be undone from the CRM</strong>, and deleted products cannot
                    be listed or recovered here afterwards. To retire a product reversibly, archive
                    it instead.
                </span>
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="confirm">
                    Type <span className="font-mono text-ink">{productTitle}</span> to confirm
                </Label>
                <Input id="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>

            {error ? (
                <div className="flex items-center gap-2 rounded-lg bg-danger-bg/50 px-3 py-2 text-sm text-danger">
                    <AlertTriangle className="h-4 w-4" />
                    {error}
                </div>
            ) : null}

            <div className="flex gap-2">
                <Button variant="danger" disabled={!matches || busy} onClick={remove}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete permanently"}
                </Button>
                <Button variant="outline" onClick={onClose} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </Shell>
    );
}

function Shell({
    title,
    onClose,
    children,
}: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-5 shadow-card">
                <div className="flex items-start justify-between gap-3">
                    <h2 className="text-lg font-semibold text-ink">{title}</h2>
                    <button onClick={onClose} className="text-ink-muted hover:text-ink" aria-label="Close">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}
