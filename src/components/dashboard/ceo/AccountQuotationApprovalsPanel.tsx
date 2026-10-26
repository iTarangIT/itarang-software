"use client";

/**
 * E-356 — the CEO's queue of ACCOUNT quotations, beside the lead quotation
 * panel on /ceo/quotations. Every row is tagged "Account" and names the
 * Account ID, so an account quote is never mistaken for a lead's. Same
 * decision rules: approve releases it (the document is made and the owner
 * told to send it); reject needs a reason and restores the previous version.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";

type Row = {
    quotation_id: string;
    account_id: string;
    account_name: string | null;
    city: string | null;
    version_no: number;
    value: number;
    line_count: number;
    credit_terms: string | null;
    notes: string | null;
    approval_status: string;
    rejection_reason: string | null;
    quote_number: string | null;
    approved_at: string | null;
    approved_by_name: string | null;
    created_at: string;
    raised_by: string | null;
    owner_name: string | null;
    oem: {
        reason: string;
        shortfall_total: number;
        lines_flagged: number;
        terms_hold: { credit_days: number | null } | null;
        lines: Array<{ product_name: string; quantity: number; quoted_unit_price: number | null; oem_price: number | null; status: string }>;
    } | null;
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const ago = (iso: string) => {
    const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
    return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(json?.error?.details?.[0]?.message ?? json?.error?.message ?? "Something went wrong.");
    return json.data as T;
}

export function AccountQuotationApprovalsPanel() {
    const [tab, setTab] = useState<"pending" | "history">("pending");
    const queryClient = useQueryClient();
    const key = ["ceo-account-quotations", tab];
    const { data, isLoading, error } = useQuery<{ total: number; set_up: boolean; quotations: Row[] }>({
        queryKey: key,
        queryFn: () => api(`/api/dashboard/ceo/account-quotations?status=${tab}`),
    });
    const [rejecting, setRejecting] = useState<string | null>(null);
    const [reason, setReason] = useState("");
    const decide = useMutation({
        mutationFn: (v: { id: string; decision: "approve" | "reject"; reason?: string }) =>
            api(`/api/dashboard/ceo/account-quotations/${v.id}/decision`, {
                method: "POST",
                body: JSON.stringify({ decision: v.decision, reason: v.reason }),
            }),
        onSuccess: () => {
            setRejecting(null);
            setReason("");
            queryClient.invalidateQueries({ queryKey: ["ceo-account-quotations"] });
        },
    });

    if (data && !data.set_up) return null;

    return (
        <section className="rounded-xl border border-border bg-surface shadow-card">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                    <h2 className="text-sm font-semibold text-ink">Account quotations</h2>
                    <p className="text-[11px] text-ink-muted">Raised for an onboarded dealer account from My Dealers — not a lead.</p>
                </div>
                <div className="flex gap-1">
                    {(["pending", "history"] as const).map((t) => (
                        <button
                            key={t}
                            type="button"
                            onClick={() => setTab(t)}
                            className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${tab === t ? "bg-brand-navy text-white" : "text-ink-muted hover:bg-bg"}`}
                        >
                            {t === "pending" ? `Pending${tab === "pending" && data ? ` · ${data.total}` : ""}` : "History"}
                        </button>
                    ))}
                </div>
            </header>
            {isLoading && (
                <div className="flex items-center gap-2 px-4 py-5 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            )}
            {error && <p className="px-4 py-5 text-sm text-rose-600">{(error as Error).message}</p>}
            {data && data.quotations.length === 0 && (
                <p className="px-4 py-5 text-sm text-ink-muted">{tab === "pending" ? "No account quotation is waiting for you." : "No decisions yet."}</p>
            )}
            {decide.error && <p className="mx-4 mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(decide.error as Error).message}</p>}
            <ul className="divide-y divide-border">
                {data?.quotations.map((q) => (
                    <li key={q.quotation_id} className="px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">Account</span>
                            <Link href={`/my-dealers/${encodeURIComponent(q.account_id)}`} className="font-semibold text-ink hover:underline">
                                {q.account_name ?? q.account_id}
                            </Link>
                            <span className="font-mono text-[11px] text-ink-muted">{q.account_id}</span>
                            <span className="text-[11px] text-ink-muted">v{q.version_no}</span>
                            <span className="ml-auto font-semibold tabular-nums">{inr(q.value)}</span>
                        </div>
                        <p className="mt-1 text-[12px] text-ink-muted">
                            Raised by {q.raised_by ?? "—"} · owner {q.owner_name ?? "none"} · {q.line_count} line{q.line_count === 1 ? "" : "s"} · {q.credit_terms ?? "Cash"}
                            {tab === "pending" ? ` · waiting ${ago(q.created_at)}` : ""}
                        </p>
                        {q.oem && (q.oem.lines_flagged > 0 || q.oem.terms_hold) && (
                            <p className="mt-1 text-[12px] text-amber-800">
                                {q.oem.lines_flagged > 0 &&
                                    `${q.oem.lines_flagged} line${q.oem.lines_flagged === 1 ? "" : "s"} below OEM reference / unpriced${q.oem.shortfall_total > 0 ? ` — short by ${inr(q.oem.shortfall_total)}` : ""}. `}
                                {q.oem.terms_hold && `Credit ${q.oem.terms_hold.credit_days ?? "?"} days needs approval.`}
                            </p>
                        )}
                        {q.oem && q.oem.lines.length > 0 && (
                            <p className="mt-1 text-[11px] text-ink-muted">
                                {q.oem.lines
                                    .map((l) => `${l.product_name} × ${l.quantity} @ ${l.quoted_unit_price != null ? inr(l.quoted_unit_price) : "—"} (OEM ${l.oem_price != null ? inr(l.oem_price) : "—"})`)
                                    .join(" · ")}
                            </p>
                        )}
                        {q.notes && <p className="mt-1 text-[12px] text-ink">Notes: {q.notes}</p>}
                        {tab === "history" && (
                            <p className="mt-1 text-[12px] text-ink-muted">
                                {q.approval_status === "approved" ? "Approved" : "Rejected"} by {q.approved_by_name ?? "—"}
                                {q.quote_number ? ` · ${q.quote_number}` : ""}
                                {q.rejection_reason ? ` — ${q.rejection_reason}` : ""}
                            </p>
                        )}
                        {tab === "pending" && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                {rejecting === q.quotation_id ? (
                                    <>
                                        <input
                                            autoFocus
                                            value={reason}
                                            onChange={(e) => setReason(e.target.value)}
                                            placeholder="Why is this rejected?"
                                            className="min-w-[220px] flex-1 rounded-lg border border-border px-2 py-1 text-xs"
                                        />
                                        <button
                                            type="button"
                                            disabled={!reason.trim() || decide.isPending}
                                            onClick={() => decide.mutate({ id: q.quotation_id, decision: "reject", reason: reason.trim() })}
                                            className="rounded-lg bg-rose-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                                        >
                                            Reject
                                        </button>
                                        <button type="button" onClick={() => setRejecting(null)} className="text-xs text-ink-muted">Cancel</button>
                                    </>
                                ) : (
                                    <>
                                        <button
                                            type="button"
                                            disabled={decide.isPending}
                                            onClick={() => decide.mutate({ id: q.quotation_id, decision: "approve" })}
                                            className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                                        >
                                            {decide.isPending && decide.variables?.id === q.quotation_id ? "Approving…" : "Approve"}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setRejecting(q.quotation_id);
                                                setReason("");
                                            }}
                                            className="rounded-lg border border-border px-3 py-1 text-xs font-semibold"
                                        >
                                            Reject…
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}
