"use client";

/**
 * E-358 — an account's quotations (24 Oct meeting, items 8–11), shared by the
 * My Dealers account page and the Admin account detail (read-only there):
 *
 *   AccountQuotationsPanel  the list, with Create / Send / Withdraw when the
 *                           server says the viewer may work this account.
 *
 * Owner creates → details → CEO approval when a line is below its OEM
 * reference price or terms are credit → after approval, send to the
 * account's email / WhatsApp → the account approves on the signed link.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Plus, Send, Trash2, Undo2 } from "lucide-react";

import type { AssetType, CommercialsProductLine, ProductMasterResponse } from "@/lib/inside-sales/types";
import { buildQuotePreview } from "@/lib/inside-sales/quotePreview";

type Quotation = {
    quotation_id: string;
    version_no: number;
    is_current: boolean;
    product_lines: CommercialsProductLine[] | null;
    total: string | null;
    credit_terms: string | null;
    notes: string | null;
    approval_status: "pending" | "approved" | "rejected";
    approval_mode: string | null;
    approved_by_name: string | null;
    rejection_reason: string | null;
    quote_number: string | null;
    quote_pdf_url: string | null;
    quote_pdf_error: string | null;
    dealer_decision: "approved" | "declined" | null;
    dealer_decision_at: string | null;
    dealer_decision_via: string | null;
    dealer_decision_note: string | null;
    withdrawn_at: string | null;
    withdraw_reason: string | null;
    created_by_name: string | null;
    created_at: string;
    is_latest_live: boolean;
    sent_count: number;
};

type PanelData = {
    account: { id: string; name: string; contact_email: string | null; contact_phone: string | null };
    can_create: boolean;
    quotations: Quotation[];
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const dmy = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        cache: "no-store",
        ...init,
        headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
        const detail = json?.error?.details?.[0]?.message;
        throw new Error(detail ?? json?.error?.message ?? "Something went wrong — try again.");
    }
    return json.data as T;
}

const qKey = (accountId: string) => ["account-quotations", accountId];

function StatusChip({ q }: { q: Quotation }) {
    const [label, tone] = q.withdrawn_at
        ? ["Withdrawn", "bg-slate-100 text-slate-600 border-slate-300"]
        : q.approval_status === "pending"
          ? ["Awaiting CEO approval", "bg-amber-50 text-amber-800 border-amber-200"]
          : q.approval_status === "rejected"
            ? ["Rejected by CEO", "bg-rose-50 text-rose-700 border-rose-200"]
            : q.dealer_decision === "approved"
              ? ["Account approved", "bg-emerald-600 text-white border-emerald-600"]
              : q.dealer_decision === "declined"
                ? ["Account declined", "bg-orange-50 text-orange-700 border-orange-200"]
                : q.sent_count > 0
                  ? ["Sent — awaiting account", "bg-sky-50 text-sky-700 border-sky-200"]
                  : [q.approval_mode === "auto" ? "Approved (auto) — not sent" : "Approved — not sent", "bg-emerald-50 text-emerald-700 border-emerald-200"];
    return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>;
}

export function AccountQuotationsPanel({ accountId, readOnly = false }: { accountId: string; readOnly?: boolean }) {
    const queryClient = useQueryClient();
    const [creating, setCreating] = useState(false);
    const [sending, setSending] = useState<Quotation | null>(null);
    const { data, isLoading, error } = useQuery<PanelData>({
        queryKey: qKey(accountId),
        queryFn: () => api(`/api/dealer-accounts/${encodeURIComponent(accountId)}/quotations`),
    });
    const refresh = () => queryClient.invalidateQueries({ queryKey: qKey(accountId) });
    const canWork = !readOnly && !!data?.can_create;

    const regenerate = useMutation({
        mutationFn: (id: string) =>
            api(`/api/dealer-accounts/${encodeURIComponent(accountId)}/quotations/${id}/draft`, {
                method: "POST",
                body: JSON.stringify({ force: true }),
            }),
        onSettled: refresh,
    });
    const withdraw = useMutation({
        mutationFn: ({ id, reason }: { id: string; reason: string }) =>
            api(`/api/dealer-accounts/${encodeURIComponent(accountId)}/quotations/${id}/withdraw`, {
                method: "POST",
                body: JSON.stringify({ reason }),
            }),
        onSettled: refresh,
    });

    return (
        <section className="rounded-xl border border-border bg-surface shadow-card">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div>
                    <h2 className="text-sm font-semibold text-ink">Account quotations</h2>
                    <p className="text-[11px] text-ink-muted">
                        Separate from lead quotations. A line below its OEM reference price, or credit terms, waits for the CEO.
                    </p>
                </div>
                {canWork && (
                    <button
                        type="button"
                        onClick={() => setCreating(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                    >
                        <Plus className="h-3.5 w-3.5" /> Create quotation
                    </button>
                )}
            </header>

            {isLoading && (
                <div className="flex items-center gap-2 px-4 py-6 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading quotations…
                </div>
            )}
            {error && <p className="px-4 py-6 text-sm text-rose-600">{(error as Error).message}</p>}
            {data && data.quotations.length === 0 && (
                <p className="px-4 py-6 text-sm text-ink-muted">
                    No quotations for this account yet.{canWork ? " Press “Create quotation” to raise one." : ""}
                </p>
            )}
            {(regenerate.error || withdraw.error) && (
                <p className="mx-4 mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {((regenerate.error || withdraw.error) as Error).message}
                </p>
            )}

            {data && data.quotations.length > 0 && (
                <ul className="divide-y divide-border">
                    {data.quotations.map((q) => {
                        const sendable = q.approval_status === "approved" && !q.withdrawn_at && q.is_latest_live && !!q.quote_pdf_url;
                        const withdrawable = !q.withdrawn_at && q.approval_status !== "rejected" && q.dealer_decision !== "approved";
                        return (
                            <li key={q.quotation_id} className="px-4 py-3 text-sm">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-semibold text-ink">v{q.version_no}</span>
                                    {q.quote_number && <span className="font-mono text-xs text-ink-muted">{q.quote_number}</span>}
                                    <StatusChip q={q} />
                                    {q.is_current && <span className="text-[11px] text-ink-muted">current</span>}
                                    <span className="ml-auto font-semibold tabular-nums text-ink">{inr(Number(q.total ?? 0))}</span>
                                </div>
                                <div className="mt-1 text-[12px] text-ink-muted">
                                    {(q.product_lines ?? []).map((l) => `${l.product_name} × ${l.quantity}`).join(" · ") || "No lines"}
                                    {" · "}
                                    {q.credit_terms ?? "Cash"} · by {q.created_by_name ?? "—"} on {dmy(q.created_at)}
                                    {q.approved_by_name && q.approval_status !== "pending" ? ` · decided by ${q.approved_by_name}` : ""}
                                </div>
                                {q.rejection_reason && <p className="mt-1 text-[12px] text-rose-700">CEO: {q.rejection_reason}</p>}
                                {q.withdraw_reason && <p className="mt-1 text-[12px] text-ink-muted">Withdrawn: {q.withdraw_reason}</p>}
                                {q.dealer_decision && (
                                    <p className="mt-1 text-[12px] text-ink-muted">
                                        Account {q.dealer_decision} on {dmy(q.dealer_decision_at)}
                                        {q.dealer_decision_via === "whatsapp" ? " over WhatsApp" : " via the link"}
                                        {q.dealer_decision_note ? ` — “${q.dealer_decision_note}”` : ""}
                                    </p>
                                )}
                                {q.quote_pdf_error && q.approval_status === "approved" && !q.quote_pdf_url && (
                                    <p className="mt-1 text-[12px] text-rose-700">The document could not be generated.</p>
                                )}
                                <div className="mt-2 flex flex-wrap gap-3 text-xs font-semibold">
                                    {q.quote_pdf_url && (
                                        <a href={q.quote_pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-sky hover:underline">
                                            <FileText className="h-3.5 w-3.5" /> Document
                                        </a>
                                    )}
                                    {canWork && q.approval_status === "approved" && !q.quote_pdf_url && !q.withdrawn_at && (
                                        <button type="button" onClick={() => regenerate.mutate(q.quotation_id)} disabled={regenerate.isPending} className="text-brand-sky hover:underline">
                                            {regenerate.isPending ? "Generating…" : "Generate document"}
                                        </button>
                                    )}
                                    {canWork && sendable && (
                                        <button type="button" onClick={() => setSending(q)} className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                                            <Send className="h-3.5 w-3.5" /> {q.sent_count > 0 ? "Send again" : "Send to account"}
                                        </button>
                                    )}
                                    {canWork && withdrawable && (
                                        <button
                                            type="button"
                                            disabled={withdraw.isPending}
                                            onClick={() => {
                                                const reason = window.prompt("Why are you withdrawing this quotation?");
                                                if (reason && reason.trim().length >= 3) withdraw.mutate({ id: q.quotation_id, reason: reason.trim() });
                                            }}
                                            className="inline-flex items-center gap-1 text-ink-muted hover:underline"
                                        >
                                            <Undo2 className="h-3.5 w-3.5" /> Withdraw
                                        </button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {creating && data && (
                <CreateAccountQuoteDialog
                    accountId={accountId}
                    accountName={data.account.name}
                    onClose={() => setCreating(false)}
                    onSaved={() => {
                        setCreating(false);
                        refresh();
                    }}
                />
            )}
            {sending && data && (
                <SendAccountQuoteDialog
                    accountId={accountId}
                    quotation={sending}
                    onClose={() => setSending(null)}
                    onSent={() => {
                        setSending(null);
                        refresh();
                    }}
                />
            )}
        </section>
    );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40" onClick={onClose} />
            <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
                <h3 className="mb-3 text-base font-semibold text-ink">{title}</h3>
                {children}
            </div>
        </div>
    );
}

const ASSET_TYPES: { key: AssetType; label: string }[] = [
    { key: "battery", label: "Battery" },
    { key: "charger", label: "Charger" },
    { key: "paraphernalia", label: "Paraphernalia" },
];

function CreateAccountQuoteDialog({
    accountId,
    accountName,
    onClose,
    onSaved,
}: {
    accountId: string;
    accountName: string;
    onClose: () => void;
    onSaved: () => void;
}) {
    const products = useQuery<ProductMasterResponse>({
        queryKey: ["inside-sales-products"],
        queryFn: () => api("/api/inside-sales/products"),
        staleTime: 5 * 60_000,
    });
    const [assetType, setAssetType] = useState<AssetType>("battery");
    const [productId, setProductId] = useState("");
    const [qty, setQty] = useState("1");
    const [lines, setLines] = useState<CommercialsProductLine[]>([]);
    const [payTerms, setPayTerms] = useState<"cash" | "credit">("cash");
    const [creditDays, setCreditDays] = useState("");
    const [notes, setNotes] = useState("");
    const [formError, setFormError] = useState<string | null>(null);

    const options = useMemo(() => products.data?.[assetType] ?? [], [products.data, assetType]);
    // List price (reference only, never the OEM price) and GST rate per product.
    const optionFor = (l: CommercialsProductLine) => products.data?.[l.asset_type]?.find((o) => o.id === l.product_id);
    const preview = buildQuotePreview(lines, (l) => optionFor(l)?.gst_rate_pct);

    const save = useMutation({
        mutationFn: () =>
            api<{ approval_status: string; auto_approved: boolean; quote_number: string | null }>(
                `/api/dealer-accounts/${encodeURIComponent(accountId)}/quotations`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        product_lines: lines,
                        terms: {
                            dealer_payment_terms: payTerms,
                            credit_days: payTerms === "credit" ? Number(creditDays) : null,
                        },
                        notes: notes.trim() || null,
                    }),
                },
            ),
        onSuccess: (r) => {
            window.alert(
                r.auto_approved
                    ? `Approved automatically${r.quote_number ? ` — ${r.quote_number}` : ""}. You can send it to the account now.`
                    : "Sent to the CEO for approval. The account sees nothing until it is approved.",
            );
            onSaved();
        },
    });

    const add = () => {
        const opt = options.find((o) => o.id === productId);
        const n = Math.floor(Number(qty));
        if (!opt || !Number.isFinite(n) || n < 1) {
            setFormError("Pick a product and a quantity.");
            return;
        }
        setFormError(null);
        setLines((prev) => {
            const i = prev.findIndex((l) => l.asset_type === assetType && l.product_id === opt.id);
            if (i >= 0) return prev.map((l, j) => (j === i ? { ...l, quantity: l.quantity + n } : l));
            return [
                ...prev,
                { asset_type: assetType, product_id: opt.id, product_name: opt.label, model_id: opt.model_id, unit_price: opt.unit_price, quantity: n },
            ];
        });
        setProductId("");
        setQty("1");
    };

    const submit = () => {
        if (lines.length === 0) return setFormError("Add at least one product.");
        const d = Number(creditDays);
        if (payTerms === "credit" && !(Number.isInteger(d) && d >= 1 && d <= 180)) {
            return setFormError("Enter the credit period in days (1–180).");
        }
        setFormError(null);
        save.mutate();
    };

    return (
        <Dialog title={`New quotation — ${accountName}`} onClose={onClose}>
            <div className="space-y-4 text-sm">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[130px_1fr_80px_auto]">
                    <select value={assetType} onChange={(e) => { setAssetType(e.target.value as AssetType); setProductId(""); }} className="rounded-lg border border-border px-2 py-1.5">
                        {ASSET_TYPES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
                    </select>
                    <select value={productId} onChange={(e) => setProductId(e.target.value)} className="rounded-lg border border-border px-2 py-1.5" disabled={products.isLoading}>
                        <option value="">{products.isLoading ? "Loading products…" : "Pick a product"}</option>
                        {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.list_price != null ? ` — list ${inr(o.list_price)}` : ""}</option>)}
                    </select>
                    <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className="rounded-lg border border-border px-2 py-1.5" aria-label="Quantity" />
                    <button type="button" onClick={add} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg">Add</button>
                </div>
                {products.error && <p className="text-xs text-rose-600">{(products.error as Error).message}</p>}

                {lines.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead className="text-ink-muted">
                                <tr>
                                    <th className="py-1 text-left font-medium">Product</th>
                                    <th className="py-1 text-right font-medium">Qty</th>
                                    <th className="py-1 text-right font-medium">List price</th>
                                    <th className="py-1 text-right font-medium">Your unit price (₹, ex-GST)</th>
                                    <th className="py-1 text-right font-medium">Amount</th>
                                    <th className="py-1 text-right font-medium">GST</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {preview.lines.map(({ line: l, amount, gstRatePct, gst }) => {
                                    const listPrice = optionFor(l)?.list_price ?? null;
                                    return (
                                        <tr key={`${l.asset_type}:${l.product_id}`}>
                                            <td className="py-1.5">{l.product_name}</td>
                                            <td className="py-1.5 text-right tabular-nums">{l.quantity}</td>
                                            <td className="py-1.5 text-right tabular-nums text-ink-muted">{listPrice != null ? inr(listPrice) : "—"}</td>
                                            <td className="py-1.5 text-right">
                                                <input
                                                    value={l.unit_price ?? ""}
                                                    inputMode="decimal"
                                                    onChange={(e) => {
                                                        const v = e.target.value.trim() === "" ? null : Number(e.target.value);
                                                        setLines((prev) => prev.map((x) => (x === l ? { ...x, unit_price: v != null && Number.isFinite(v) ? v : null } : x)));
                                                    }}
                                                    aria-label={`Unit price for ${l.product_name}`}
                                                    className="w-28 rounded border border-border px-2 py-1 text-right"
                                                />
                                            </td>
                                            <td className="py-1.5 text-right tabular-nums">{amount != null ? inr(amount) : "—"}</td>
                                            <td className="py-1.5 text-right tabular-nums">
                                                {gst != null ? inr(gst) : "—"}
                                                {gstRatePct != null && <span className="ml-1 text-ink-muted">({gstRatePct}%)</span>}
                                            </td>
                                            <td className="py-1.5 text-right">
                                                <button type="button" onClick={() => setLines((p) => p.filter((x) => x !== l))} aria-label="Remove line">
                                                    <Trash2 className="h-3.5 w-3.5 text-ink-muted" />
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                <QuoteTotals subTotal={preview.subTotal} gstTotal={preview.gstTotal} total={preview.total} hasUnsetGst={preview.hasUnsetGst} hasUnpriced={preview.hasUnpriced} />

                <div className="flex flex-wrap items-center gap-4">
                    <span className="text-xs font-medium text-ink-muted">Dealer payment terms</span>
                    <label className="flex items-center gap-1.5 text-xs"><input type="radio" checked={payTerms === "cash"} onChange={() => setPayTerms("cash")} /> Cash</label>
                    <label className="flex items-center gap-1.5 text-xs"><input type="radio" checked={payTerms === "credit"} onChange={() => setPayTerms("credit")} /> Credit</label>
                    {payTerms === "credit" && (
                        <input value={creditDays} onChange={(e) => setCreditDays(e.target.value)} placeholder="Days" inputMode="numeric" className="w-20 rounded-lg border border-border px-2 py-1 text-xs" />
                    )}
                </div>
                {payTerms === "credit" && <p className="text-[11px] text-amber-700">Credit terms always go to the CEO for approval.</p>}
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={5000} placeholder="Notes printed on the quotation (optional)" className="w-full rounded-lg border border-border px-2 py-1.5 text-xs" />
                <p className="text-[11px] text-ink-muted">Warranty and delivery are the standard terms set by Admin.</p>

                {(formError || save.error) && (
                    <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{formError ?? (save.error as Error).message}</p>
                )}
                <div className="flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold">Cancel</button>
                    <button type="button" onClick={submit} disabled={save.isPending} className="rounded-lg bg-brand-navy px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                        {save.isPending ? "Saving…" : "Save quotation"}
                    </button>
                </div>
            </div>
        </Dialog>
    );
}

function QuoteTotals(p: { subTotal: number; gstTotal: number; total: number; hasUnsetGst: boolean; hasUnpriced: boolean }) {
    return (
        <div className="ml-auto w-full max-w-xs space-y-0.5 rounded-lg bg-bg px-3 py-2 text-xs">
            <div className="flex justify-between"><span className="text-ink-muted">Sub-total (ex-GST)</span><span className="tabular-nums">{inr(p.subTotal)}</span></div>
            <div className="flex justify-between"><span className="text-ink-muted">GST</span><span className="tabular-nums">{inr(p.gstTotal)}</span></div>
            <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold"><span>Total incl. GST</span><span className="tabular-nums">{inr(p.total)}</span></div>
            {p.hasUnpriced && <p className="text-[11px] text-amber-700">A line has no unit price yet — it is not in the total.</p>}
            {p.hasUnsetGst && <p className="text-[11px] text-amber-700">A product has no GST rate set — its GST is not included.</p>}
        </div>
    );
}

type SendInfo = {
    quote_number: string | null;
    email: string | null;
    phone: string | null;
    not_sendable: string | null;
    dispatches: Array<{ dispatch_id: string; channel: string; recipient: string; status: string; error: string | null; sent_by_name: string | null; created_at: string }>;
};

function SendAccountQuoteDialog({
    accountId,
    quotation,
    onClose,
    onSent,
}: {
    accountId: string;
    quotation: Quotation;
    onClose: () => void;
    onSent: () => void;
}) {
    const url = `/api/dealer-accounts/${encodeURIComponent(accountId)}/quotations/${quotation.quotation_id}/send`;
    const info = useQuery<SendInfo>({ queryKey: ["account-quote-send", quotation.quotation_id], queryFn: () => api(url) });
    const [useEmail, setUseEmail] = useState(true);
    const [useWa, setUseWa] = useState(true);
    const [email, setEmail] = useState<string | null>(null);
    const [phone, setPhone] = useState<string | null>(null);
    const [message, setMessage] = useState("");
    const send = useMutation({
        mutationFn: () =>
            api<{ outcomes: Array<{ channel: string; status: string; error?: string }>; sent_count: number }>(url, {
                method: "POST",
                body: JSON.stringify({
                    channels: [...(useEmail ? ["email"] : []), ...(useWa ? ["whatsapp"] : [])],
                    email: useEmail ? (email ?? info.data?.email ?? null) || null : null,
                    phone: useWa ? (phone ?? info.data?.phone ?? null) || null : null,
                    message: message.trim() || null,
                }),
            }),
        onSuccess: (r) => {
            const failed = r.outcomes.filter((o) => o.status !== "sent");
            if (failed.length) window.alert(failed.map((o) => `${o.channel}: ${o.error ?? "failed"}`).join("\n"));
            if (r.sent_count > 0) onSent();
        },
    });

    return (
        <Dialog title={`Send ${quotation.quote_number ?? `v${quotation.version_no}`} to the account`} onClose={onClose}>
            {info.isLoading ? (
                <p className="text-sm text-ink-muted">Loading…</p>
            ) : info.error ? (
                <p className="text-sm text-rose-600">{(info.error as Error).message}</p>
            ) : (
                <div className="space-y-3 text-sm">
                    {info.data?.not_sendable && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{info.data.not_sendable}</p>}
                    <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={useEmail} onChange={(e) => setUseEmail(e.target.checked)} /> Email
                        <input value={email ?? info.data?.email ?? ""} onChange={(e) => setEmail(e.target.value)} disabled={!useEmail} placeholder="account@example.com" className="flex-1 rounded-lg border border-border px-2 py-1" />
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={useWa} onChange={(e) => setUseWa(e.target.checked)} /> WhatsApp
                        <input value={phone ?? info.data?.phone ?? ""} onChange={(e) => setPhone(e.target.value)} disabled={!useWa} placeholder="10-digit mobile" className="flex-1 rounded-lg border border-border px-2 py-1" />
                    </label>
                    <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={2000} placeholder="Covering note (optional)" className="w-full rounded-lg border border-border px-2 py-1.5 text-xs" />
                    <p className="text-[11px] text-ink-muted">The account gets the PDF and a link to approve it. The owner, you and the Admin CC list are copied.</p>
                    {send.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(send.error as Error).message}</p>}
                    {(info.data?.dispatches.length ?? 0) > 0 && (
                        <div className="rounded-lg border border-border p-2 text-[11px] text-ink-muted">
                            <p className="mb-1 font-semibold">Earlier sends</p>
                            {info.data!.dispatches.map((d) => (
                                <p key={d.dispatch_id}>
                                    {dmy(d.created_at)} · {d.channel} to {d.recipient} · {d.status}
                                    {d.error ? ` (${d.error})` : ""}
                                    {d.sent_by_name ? ` · by ${d.sent_by_name}` : ""}
                                </p>
                            ))}
                        </div>
                    )}
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold">Cancel</button>
                        <button
                            type="button"
                            onClick={() => send.mutate()}
                            disabled={send.isPending || (!useEmail && !useWa) || !!info.data?.not_sendable}
                            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                        >
                            {send.isPending ? "Sending…" : "Send"}
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
}
