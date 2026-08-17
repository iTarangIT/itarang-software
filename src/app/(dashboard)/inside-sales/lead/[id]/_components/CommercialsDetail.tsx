"use client";

/**
 * One commercials version, rendered whole.
 *
 * ## Why this is its own file
 *
 * It is used in two places — the current version, and every row of the version
 * history — and the two must never disagree about what a quotation says. Before
 * this existed, the current version got a full field grid and a past version got
 * `v1 · quote_issue · 17/8/2026`: the same record, told two different ways, and
 * only one of them answered "what did we actually quote".
 *
 * Lifting it out also stops LeadDetailRightPane growing; it was already past 400
 * lines with this inline.
 *
 * PRESENTATIONAL. No fetching, no state of its own beyond the caller's expand
 * flag — everything it draws is already in the lead bundle.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { diffCommercials, summariseChanges } from "@/lib/inside-sales/commercialsDiff";
import type { LeadDetailCommercials } from "@/lib/inside-sales/types";

export function fmtDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

/** The two event types E-221 gates. Everything else is born approved. */
export function isGatedQuote(eventType: string): boolean {
    return eventType === "quote_issue" || eventType === "quote_revision";
}

/**
 * Label over value, with an em dash for absence.
 *
 * Lives here rather than in the pane because this file holds most of its uses
 * and the pane imports it back — one direction, no cycle.
 */
export function Field({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">{label}</div>
            <div className="text-sm text-gray-900 break-words">
                {value === null || value === undefined || value === "" ? <span className="text-gray-400">—</span> : value}
            </div>
        </div>
    );
}

/**
 * E-242 — approval outcome, generated draft, and the way to send it.
 *
 * The Send button is only rendered once the quote is approved AND a document
 * exists, matching what the send route will actually accept. A pending or
 * rejected quote shows why instead — the rejection reason in particular, which
 * until E-242 was stored and never displayed anywhere.
 *
 * `onSend` is omitted for a superseded version, which is what removes the
 * button there. Sending an older approved quote is not a capability being taken
 * away — it never existed — and the case it would enable is the one that bites:
 * the sandbox lead where v1 (₹40,000) was approved after v2 (₹51,000) had
 * already gone to the dealer.
 */
export function QuoteApprovalBlock({
    cc,
    onSend,
}: {
    cc: LeadDetailCommercials;
    onSend?: () => void;
}) {
    const status = cc.approval_status ?? "approved";
    const tone =
        status === "approved"
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : status === "rejected"
              ? "border-rose-200 bg-rose-50 text-rose-900"
              : "border-amber-200 bg-amber-50 text-amber-900";

    const label =
        status === "approved"
            ? cc.approval_mode === "auto"
                ? "Auto-approved (at or above OEM reference)"
                : "Approved"
            : status === "rejected"
              ? "Rejected"
              : "Awaiting CEO approval";

    return (
        <div className={`rounded-lg border px-3 py-2.5 text-xs ${tone}`}>
            <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{label}</span>
                {cc.approved_at && (
                    <span className="tabular-nums opacity-70">{fmtDate(cc.approved_at)}</span>
                )}
            </div>

            {status === "rejected" && cc.rejection_reason && (
                <p className="mt-1.5 whitespace-pre-wrap opacity-90">
                    <span className="font-medium">Reason:</span> {cc.rejection_reason}
                </p>
            )}

            {status === "approved" && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    {cc.quote_number && (
                        <span className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold">
                            {cc.quote_number}
                        </span>
                    )}
                    {cc.quote_pdf_url ? (
                        <a
                            href={cc.quote_pdf_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium underline underline-offset-2"
                        >
                            Preview draft
                        </a>
                    ) : (
                        <span className="opacity-80">
                            {cc.quote_pdf_error
                                ? "Draft generation failed — open Send to retry."
                                : "Draft not generated yet."}
                        </span>
                    )}
                    {onSend && (
                        <button
                            onClick={onSend}
                            className="ml-auto rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                        >
                            {cc.dealer_decision ? "Resend / view" : "Send to dealer"}
                        </button>
                    )}
                </div>
            )}

            {/*
              * E-243 — what the DEALER said back. Separate from the block above
              * because they answer different questions: that one is whether
              * iTarang released the number, this one is whether the dealer
              * accepted it. A quote can be approved by us and declined by them.
              */}
            {status === "approved" && cc.dealer_decision && (
                <div
                    className={`mt-2 rounded-md border px-2 py-1.5 text-[11px] ${
                        cc.dealer_decision === "approved"
                            ? "border-emerald-300 bg-emerald-100/60 text-emerald-900"
                            : "border-slate-300 bg-slate-100 text-slate-700"
                    }`}
                >
                    <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">
                            Dealer {cc.dealer_decision === "approved" ? "approved" : "declined"}
                            {cc.dealer_decision_via
                                ? ` · via ${cc.dealer_decision_via === "whatsapp" ? "WhatsApp" : "approval link"}`
                                : ""}
                        </span>
                        {cc.dealer_decision_at && (
                            <span className="tabular-nums opacity-70">
                                {fmtDate(cc.dealer_decision_at)}
                            </span>
                        )}
                    </div>
                    {cc.dealer_decision_note && (
                        <p className="mt-1 whitespace-pre-wrap opacity-90">
                            &ldquo;{cc.dealer_decision_note}&rdquo;
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

export function ProductLines({ lines }: { lines: LeadDetailCommercials["product_lines"] }) {
    if (!lines?.length) return null;
    const total = lines.reduce(
        (s, p) => s + (p.unit_price != null ? p.unit_price * p.quantity : 0),
        0,
    );
    return (
        <div className="col-span-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Products</div>
            <ul className="space-y-1">
                {lines.map((p, i) => (
                    <li
                        key={`${p.asset_type}-${p.product_id}-${i}`}
                        className="flex items-center gap-2 rounded border border-gray-100 bg-gray-50/60 px-2 py-1 text-xs"
                    >
                        <span className="shrink-0 rounded bg-gray-200 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-gray-600">
                            {p.asset_type}
                        </span>
                        <span className="flex-1 truncate text-gray-800">{p.product_name}</span>
                        <span className="shrink-0 tabular-nums text-gray-600">× {p.quantity}</span>
                        {p.unit_price != null && (
                            <span className="shrink-0 tabular-nums text-gray-900">
                                ₹{(p.unit_price * p.quantity).toLocaleString("en-IN")}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
            <div className="mt-1 flex items-center justify-end gap-2 text-xs">
                <span className="text-gray-500">Total</span>
                <span className="font-semibold tabular-nums text-gray-900">
                    ₹{total.toLocaleString("en-IN")}
                </span>
            </div>
        </div>
    );
}

/**
 * Everything one version says. Nothing the rep entered is omitted — that is the
 * point of the component: the fields exist on every version in the bundle, and
 * before this only the current one showed them.
 */
export function CommercialsDetail({
    cc,
    onSend,
}: {
    cc: LeadDetailCommercials;
    /** Omitted on a superseded version — see QuoteApprovalBlock. */
    onSend?: () => void;
}) {
    return (
        <div className="grid grid-cols-2 gap-3">
            <Field label="Price Quoted" value={cc.price_quoted ? `₹${cc.price_quoted}` : null} />
            <Field label="Final Price" value={cc.final_price ? `₹${cc.final_price}` : null} />
            <Field label="Payment Method" value={cc.payment_method} />
            <Field label="Credit Terms" value={cc.credit_terms} />
            <Field label="Delivery Terms" value={cc.delivery_terms} />
            <Field label="Warranty" value={cc.warranty_terms} />

            <ProductLines lines={cc.product_lines} />

            <div className="col-span-2">
                <Field
                    label="Deal Notes"
                    value={cc.deal_notes ? <p className="whitespace-pre-wrap">{cc.deal_notes}</p> : null}
                />
            </div>

            {/* The rep's own free-text note on this event, distinct from deal
                notes: that one describes the deal, this one describes the
                update. Neither was shown on a past version until now. */}
            {cc.notes && (
                <div className="col-span-2">
                    <Field label="Update Note" value={<p className="whitespace-pre-wrap">{cc.notes}</p>} />
                </div>
            )}

            {isGatedQuote(cc.event_type) && (
                <div className="col-span-2">
                    <QuoteApprovalBlock cc={cc} onSend={onSend} />
                </div>
            )}

            {cc.quote_document_url && (
                <div className="col-span-2">
                    <Field
                        label="Quote Document (attached by rep)"
                        value={
                            <a href={cc.quote_document_url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline text-sm">
                                Open quote
                            </a>
                        }
                    />
                </div>
            )}

            {cc.brochure_url && (
                <div className="col-span-2">
                    <Field
                        label="Brochure"
                        value={
                            <a href={cc.brochure_url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline text-sm">
                                Open brochure
                            </a>
                        }
                    />
                </div>
            )}
        </div>
    );
}

/** approved / rejected / pending, as a chip small enough for a row header. */
function StatusChip({ cc }: { cc: LeadDetailCommercials }) {
    if (!isGatedQuote(cc.event_type)) return null;
    const status = cc.approval_status ?? "approved";
    const tone =
        status === "approved"
            ? "bg-emerald-100 text-emerald-800"
            : status === "rejected"
              ? "bg-rose-100 text-rose-800"
              : "bg-amber-100 text-amber-800";
    const label =
        status === "approved"
            ? cc.approval_mode === "auto"
                ? "auto-approved"
                : "approved"
            : status;
    return (
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>
            {label}
        </span>
    );
}

/**
 * Every version of the quotation, newest first, each expanding to what it said.
 *
 * ## What this replaces
 *
 * A list of `v2 · quote_issue · 17/8/2026`. Every field it now shows — approval
 * outcome, rejection reason, quote number, the document, the dealer's answer —
 * was already in `bundle.commercials_history` and rendered nowhere, so a
 * rejected version was indistinguishable from an approved one and there was no
 * way to read what a superseded quote had actually offered.
 *
 * ## Why the changes are computed against the previous version
 *
 * The badge answers "what did this revision change", which is a statement about
 * the step. Diffing against the current version instead would make every row
 * restate the same delta. See diffCommercials.
 *
 * Newest first to match the touchpoint log beside it, but the diff is always
 * taken in version order regardless of how the list is displayed.
 */
export function CommercialsVersionHistory({
    history,
}: {
    history: LeadDetailCommercials[];
}) {
    const [open, setOpen] = useState<string | null>(null);

    if (history.length <= 1) return null;

    const ascending = [...history].sort((a, b) => a.version_no - b.version_no);
    const rows = [...ascending].reverse();

    return (
        <details className="rounded-md border border-gray-100 bg-gray-50/50 px-3 py-2 text-xs">
            <summary className="cursor-pointer text-gray-700 font-medium">
                Version history ({history.length} versions)
            </summary>

            <ol className="mt-2 space-y-1.5">
                {rows.map((c) => {
                    const i = ascending.findIndex((v) => v.commercial_id === c.commercial_id);
                    const changes = diffCommercials(i > 0 ? ascending[i - 1] : null, c);
                    const summary = summariseChanges(changes);
                    const expanded = open === c.commercial_id;

                    return (
                        <li
                            key={c.commercial_id}
                            className="rounded-md border border-gray-200 bg-white px-2 py-1.5"
                        >
                            <button
                                type="button"
                                onClick={() => setOpen(expanded ? null : c.commercial_id)}
                                className="flex w-full items-start gap-2 text-left"
                            >
                                {expanded ? (
                                    <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" />
                                ) : (
                                    <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" />
                                )}
                                <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-1.5">
                                        <span className={c.is_current ? "font-semibold text-gray-900" : "text-gray-700"}>
                                            v{c.version_no} · {c.event_type}
                                        </span>
                                        {c.is_current && (
                                            <span className="shrink-0 rounded bg-gray-900 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                                current
                                            </span>
                                        )}
                                        <StatusChip cc={c} />
                                        {c.quote_number && (
                                            <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-700">
                                                {c.quote_number}
                                            </span>
                                        )}
                                        {c.dealer_decision && (
                                            <span
                                                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                                    c.dealer_decision === "approved"
                                                        ? "bg-emerald-100 text-emerald-800"
                                                        : "bg-slate-200 text-slate-700"
                                                }`}
                                            >
                                                dealer {c.dealer_decision}
                                            </span>
                                        )}
                                    </span>
                                    {/* Empty for the first version, which changed
                                        nothing because there was nothing before it. */}
                                    {summary && (
                                        <span className="mt-0.5 block text-[11px] text-gray-500">{summary}</span>
                                    )}
                                </span>
                                <span className="shrink-0 text-gray-500">{fmtDate(c.created_at)}</span>
                            </button>

                            {expanded && (
                                <div className="mt-2 border-t border-gray-100 pt-2">
                                    <CommercialsDetail cc={c} />
                                </div>
                            )}
                        </li>
                    );
                })}
            </ol>
        </details>
    );
}
