"use client";

/**
 * Tracker ID 5 (E-334) — "Order placed", shared by My dealers, Dealer Health
 * and the Invoice Ledger:
 *   OrderPlacedButton  record an order before its invoice exists
 *   OrderClaimBadge    a row's open claim (awaiting invoice / no invoice raised)
 *   OrderClaimsList    "Order claimed, no invoice raised" — the exception list
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { ORDER_CLAIM_WINDOW_DAYS } from "@/lib/dealers/accountHealthRules";
import type { DealerHealthRow } from "@/lib/dealers/accountHealth";
import type { OrderClaimRow } from "@/lib/accounts/orderClaims";

/** Every query that shows a dealer's bucket or a claim. */
const CLAIM_QUERY_KEYS = [["dealer-health"], ["my-dealers"], ["order-claims"]];

function istToday(): string {
    return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}
function shiftDays(iso: string, n: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
const dmy = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

async function post(url: string, body: unknown): Promise<void> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Something went wrong — try again.");
}

function useInvalidateClaims() {
    const queryClient = useQueryClient();
    return () => CLAIM_QUERY_KEYS.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
}

export function OrderPlacedButton({ accountId }: { accountId: string }) {
    const today = istToday();
    const [open, setOpen] = useState(false);
    const [orderDate, setOrderDate] = useState(today);
    const [po, setPo] = useState("");
    const [note, setNote] = useState("");
    const invalidate = useInvalidateClaims();
    const save = useMutation({
        mutationFn: () =>
            post(`/api/dealer-accounts/${encodeURIComponent(accountId)}/order-placed`, {
                order_date: orderDate,
                po_number: po || null,
                note: note || null,
            }),
        onSuccess: () => {
            setOpen(false);
            setPo("");
            setNote("");
            invalidate();
        },
    });

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => {
                    setOrderDate(today);
                    save.reset();
                    setOpen(true);
                }}
                className="text-xs font-semibold text-emerald-700 hover:underline"
            >
                Order placed
            </button>
        );
    }
    return (
        <div className="flex flex-col items-end gap-1 text-left">
            <label className="flex items-center gap-1 text-[11px] text-ink-muted">
                Order date
                <input
                    type="date"
                    value={orderDate}
                    min={shiftDays(today, -ORDER_CLAIM_WINDOW_DAYS)}
                    max={today}
                    onChange={(e) => setOrderDate(e.target.value)}
                    className="rounded-lg border border-border px-2 py-1 text-xs"
                />
            </label>
            <input
                value={po}
                onChange={(e) => setPo(e.target.value)}
                placeholder="PO number (optional)"
                maxLength={100}
                className="w-56 rounded-lg border border-border px-2 py-1 text-xs"
            />
            <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)"
                maxLength={500}
                className="w-56 rounded-lg border border-border px-2 py-1 text-xs"
            />
            <p className="w-56 text-[11px] text-ink-muted">
                Reminders pause for {ORDER_CLAIM_WINDOW_DAYS} days from the order date. An invoice in that time confirms it.
            </p>
            <div className="flex gap-2">
                <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-muted">
                    Cancel
                </button>
                <button
                    type="button"
                    disabled={save.isPending || !orderDate}
                    onClick={() => save.mutate()}
                    className="text-xs font-semibold text-emerald-700 disabled:opacity-40"
                >
                    {save.isPending ? "Saving…" : "Save order"}
                </button>
            </div>
            {save.isError && <span className="w-56 text-[11px] text-rose-600">{(save.error as Error).message}</span>}
        </div>
    );
}

export function OrderClaimBadge({ claim }: { claim: NonNullable<DealerHealthRow["order_claim"]> }) {
    const po = claim.po_number ? ` · PO ${claim.po_number}` : "";
    return claim.status === "pending" ? (
        <div className="mt-1 text-[11px] text-emerald-700">
            Order placed {dmy(claim.order_date)}
            {po} — awaiting invoice
        </div>
    ) : (
        <div className="mt-1 text-[11px] font-medium text-rose-700">
            Order claimed {dmy(claim.order_date)}
            {po} — no invoice raised
        </div>
    );
}

function WithdrawButton({ claimId }: { claimId: number }) {
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState("");
    const invalidate = useInvalidateClaims();
    const withdraw = useMutation({
        mutationFn: () => post(`/api/dealer-accounts/order-claims/${claimId}`, { action: "withdraw", reason }),
        onSuccess: () => {
            setOpen(false);
            setReason("");
            invalidate();
        },
    });
    if (!open) {
        return (
            <button type="button" onClick={() => setOpen(true)} className="text-xs font-semibold text-ink-muted hover:underline">
                Withdraw
            </button>
        );
    }
    return (
        <div className="flex flex-col items-end gap-1">
            <input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why? e.g. dealer cancelled"
                className="w-48 rounded-lg border border-border px-2 py-1 text-xs"
            />
            <div className="flex gap-2">
                <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-muted">
                    Cancel
                </button>
                <button
                    type="button"
                    disabled={withdraw.isPending || reason.trim().length < 3}
                    onClick={() => withdraw.mutate()}
                    className="text-xs font-semibold text-rose-700 disabled:opacity-40"
                >
                    Withdraw order
                </button>
            </div>
            {withdraw.isError && <span className="text-[11px] text-rose-600">{(withdraw.error as Error).message}</span>}
        </div>
    );
}

/**
 * "Order claimed, no invoice raised": orders recorded more than
 * ORDER_CLAIM_WINDOW_DAYS ago with no invoice since. The API scopes it — every
 * account for managers and finance, their own for an owner.
 */
export function OrderClaimsList({
    canWithdraw,
    mine = false,
    title = "Order claimed, no invoice raised",
}: {
    canWithdraw: boolean;
    /** Only the viewer's own accounts, whatever their role. */
    mine?: boolean;
    title?: string;
}) {
    const { data, isLoading, error } = useQuery<{ rows: OrderClaimRow[]; available: boolean }>({
        queryKey: ["order-claims", "unconfirmed", mine],
        queryFn: async () => {
            const res = await fetch(`/api/dealer-accounts/order-claims?status=unconfirmed${mine ? "&mine=1" : ""}`, {
                cache: "no-store",
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load the order claims");
            return json.data;
        },
    });
    if (isLoading) {
        return (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
        );
    }
    if (error) return <p className="text-sm text-rose-600">{(error as Error).message}</p>;
    if (!data?.available) return null;
    const rows = data.rows;
    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">
                    {title} · {rows.length}
                </h2>
                <p className="text-[11px] text-ink-muted">
                    &ldquo;Order placed&rdquo; was recorded, but no invoice for the dealer is dated within{" "}
                    {ORDER_CLAIM_WINDOW_DAYS} days of the order. Raise the invoice, or withdraw the order if it did not happen.
                </p>
            </div>
            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Dealer</th>
                            <th className="px-3 py-2 text-left font-semibold">Owner</th>
                            <th className="px-3 py-2 text-left font-semibold">Order date</th>
                            <th className="px-3 py-2 text-left font-semibold">PO number</th>
                            <th className="px-3 py-2 text-left font-semibold">Recorded by</th>
                            <th className="px-3 py-2 text-right font-semibold">Days overdue</th>
                            {canWithdraw && <th className="px-3 py-2" />}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.length === 0 && (
                            <tr>
                                <td colSpan={canWithdraw ? 7 : 6} className="px-3 py-6 text-center text-ink-muted">
                                    Every recorded order has its invoice.
                                </td>
                            </tr>
                        )}
                        {rows.map((c) => (
                            <tr key={c.id}>
                                <td className="px-3 py-2 font-medium text-ink">
                                    {c.dealer}
                                    {c.note && <div className="text-[11px] font-normal text-ink-muted">{c.note}</div>}
                                </td>
                                <td className="px-3 py-2 text-ink">{c.owner_name ?? "—"}</td>
                                <td className="px-3 py-2 text-ink-muted">{dmy(c.order_date)}</td>
                                <td className="px-3 py-2 text-ink-muted">{c.po_number ?? "—"}</td>
                                <td className="px-3 py-2 text-ink-muted">{c.claimed_by_name ?? "—"}</td>
                                <td className="px-3 py-2 text-right tabular-nums text-rose-700">{c.days_overdue}</td>
                                {canWithdraw && (
                                    <td className="px-3 py-2 text-right">
                                        <WithdrawButton claimId={c.id} />
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
