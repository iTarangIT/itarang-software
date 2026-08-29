"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EcommerceVariant } from "@/lib/ecommerce/types";

type Stock = { variantId: string; quantity: number | null; manageInventory: boolean };

export function InventoryDialog({
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
    // What the operator is deciding against. Sent back as expectedQuantity so the
    // server can refuse the write if stock moved in the meantime.
    const [baseline, setBaseline] = useState<number | null>(variant.inventoryQuantity);
    const [tracked, setTracked] = useState(variant.manageInventory);
    const [qty, setQty] = useState(
        variant.inventoryQuantity === null ? "" : String(variant.inventoryQuantity),
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [drift, setDrift] = useState<number | null>(null);
    const [confirmUntrack, setConfirmUntrack] = useState(false);

    const parsed = /^\d+$/.test(qty.trim()) ? Number(qty.trim()) : null;
    const qtyChanged = parsed !== null && parsed !== baseline;

    async function send(payload: Record<string, unknown>) {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/ecommerce/products/${productId}/inventory`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ variantId: variant.id, ...payload }),
            });
            const body = await res.json().catch(() => null);
            if (res.status === 409) {
                // Stock moved. Nothing was written - re-baseline and make the
                // operator decide again against the current number.
                setDrift(body?.error?.details?.currentQuantity ?? null);
                setError(body?.error?.message ?? "Stock changed since this form was opened.");
                return;
            }
            if (!res.ok) throw new Error(body?.error?.message ?? "Update failed");
            const saved = body.data as Stock;
            setBaseline(saved.quantity);
            setTracked(saved.manageInventory);
            setQty(saved.quantity === null ? "" : String(saved.quantity));
            setDrift(null);
            onSaved();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Update failed");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-5 shadow-card">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h2 className="text-lg font-semibold text-ink">Adjust stock</h2>
                        <p className="text-xs text-ink-muted">{variant.title}</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-ink-muted hover:text-ink"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="rounded-lg border border-warning/30 bg-warning-bg/50 px-3 py-2 text-xs text-ink">
                    This store permits <strong>backorders</strong> — Hostinger will accept orders
                    below zero stock and will not block overselling. Checked manually 2026-08-23;
                    the API does not expose this setting, so it is not live data.
                </div>

                {tracked ? (
                    <div className="space-y-1.5">
                        <Label htmlFor="qty">Units in stock</Label>
                        <Input
                            id="qty"
                            value={qty}
                            inputMode="numeric"
                            onChange={(e) => setQty(e.target.value)}
                        />
                        <p className="text-xs text-ink-muted">
                            {qty.trim() === "" || parsed === null ? (
                                <span className="text-danger">Whole number, 0 or more.</span>
                            ) : (
                                <>
                                    Currently <span className="font-mono text-ink">{baseline}</span>.
                                    Saving sets the total to{" "}
                                    <span className="font-mono text-ink">{parsed}</span> — an
                                    absolute value, not an adjustment.
                                </>
                            )}
                        </p>
                    </div>
                ) : (
                    <p className="rounded-lg bg-bg/50 px-3 py-2 text-sm text-ink-muted">
                        Stock is <strong className="text-ink">not tracked</strong> for this variant.
                        The storefront treats it as unlimited.
                    </p>
                )}

                {drift !== null ? (
                    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg/60 px-3 py-2 text-sm text-ink">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                        <span>
                            Nothing was written. Stock is now <strong>{drift ?? "untracked"}</strong>.
                            Check the figure and save again to overwrite it.
                        </span>
                    </div>
                ) : null}

                {error && drift === null ? (
                    <div className="flex items-center gap-2 rounded-lg bg-danger-bg/50 px-3 py-2 text-sm text-danger">
                        <AlertTriangle className="h-4 w-4" />
                        {error}
                    </div>
                ) : null}

                <p className="text-[11px] leading-relaxed text-ink-muted">
                    The current figure is re-checked immediately before saving, which narrows the
                    window but cannot close it — a purchase landing in the same moment can still be
                    overwritten.
                </p>

                {tracked ? (
                    <div className="flex flex-wrap gap-2">
                        <Button
                            disabled={busy || parsed === null || (!qtyChanged && drift === null)}
                            onClick={() =>
                                send({
                                    quantity: parsed,
                                    // Omitted after a drift block: the operator has now seen the
                                    // current value, so re-sending a stale baseline would loop.
                                    ...(drift === null && baseline !== null
                                        ? { expectedQuantity: baseline }
                                        : {}),
                                })
                            }
                        >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save stock"}
                        </Button>
                        <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => setConfirmUntrack(true)}
                        >
                            Stop tracking stock
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-2">
                        <Label htmlFor="init">Initial stock</Label>
                        <Input
                            id="init"
                            value={qty}
                            inputMode="numeric"
                            onChange={(e) => setQty(e.target.value)}
                        />
                        <p className="text-xs text-ink-muted">
                            Required — Hostinger defaults new tracking to 0, which would publish
                            this product as out of stock.
                        </p>
                        <Button
                            disabled={busy || parsed === null}
                            onClick={() => send({ manageInventory: true, quantity: parsed })}
                        >
                            {busy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                "Start tracking stock"
                            )}
                        </Button>
                    </div>
                )}

                {confirmUntrack ? (
                    <div className="space-y-3 rounded-lg border border-danger/30 bg-danger-bg/40 px-3 py-3 text-sm text-ink">
                        <p>
                            Turning tracking off makes the storefront treat this product as{" "}
                            <strong>unlimited stock</strong> — orders will never be blocked by
                            stock. Hostinger keeps the current figure ({baseline}) but stops
                            applying it, so it will be stale if you switch tracking back on.
                        </p>
                        <div className="flex gap-2">
                            <Button
                                variant="danger"
                                disabled={busy}
                                onClick={() => {
                                    setConfirmUntrack(false);
                                    void send({ manageInventory: false });
                                }}
                            >
                                Stop tracking
                            </Button>
                            <Button variant="ghost" onClick={() => setConfirmUntrack(false)}>
                                Cancel
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
