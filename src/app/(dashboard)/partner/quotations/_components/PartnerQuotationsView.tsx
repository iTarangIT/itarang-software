"use client";

/**
 * The partner's PI list. Three tabs over one endpoint
 * (GET /api/partner/quotations) — pending with the CEO, approved (with the
 * proforma PDF and a Send button), rejected (with the reason).
 *
 * Reuses QuotationSendDialog from the ISR lead page rather than a copy, so
 * sending from here and sending from the lead page are the same thing — same
 * endpoint, same outcome recording.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, FileText, Send } from "lucide-react";
import {
    QuotationSendDialog,
    type QuotationTerms,
} from "@/app/(dashboard)/inside-sales/lead/[id]/_components/QuotationSendDialog";

export type PartnerQuotationStatus = "pending" | "approved" | "rejected";

export interface PartnerQuotation {
    commercial_id: string;
    dealer_lead_id: string;
    version_no: number;
    is_current: boolean;
    event_type: string;
    value: number;
    quote_number: string | null;
    quote_pdf_url: string | null;
    quote_pdf_error: string | null;
    quote_document_url: string | null;
    approval_status: PartnerQuotationStatus;
    approval_mode: string | null;
    approved_at: string | null;
    approved_by_name: string | null;
    rejection_reason: string | null;
    dealer_decision: string | null;
    dealer_decision_at: string | null;
    created_at: string | null;
    dealer_name: string | null;
    shop_name: string | null;
    dealer_phone: string | null;
    city: string | null;
    state: string | null;
    lead_status: string | null;
    terms: QuotationTerms;
}

export interface PartnerQuotationsPayload {
    status: PartnerQuotationStatus | "all";
    counts: Record<PartnerQuotationStatus, number>;
    quotations: PartnerQuotation[];
    capped: boolean;
}

const TABS: Array<{ key: PartnerQuotationStatus; label: string }> = [
    { key: "pending", label: "Pending with CEO" },
    { key: "approved", label: "Approved" },
    { key: "rejected", label: "Rejected" },
];

export const QUOTATIONS_QUERY_KEY = "partner-quotations";

export async function fetchPartnerQuotations(
    status: PartnerQuotationStatus | "all",
): Promise<PartnerQuotationsPayload> {
    const res = await fetch(`/api/partner/quotations?status=${status}`, { cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message ?? "Failed to load quotations");
    }
    return json.data as PartnerQuotationsPayload;
}

const inr = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
});

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

export function statusTone(status: PartnerQuotationStatus): string {
    return status === "approved"
        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
        : status === "rejected"
          ? "border-rose-200 bg-rose-50 text-rose-900"
          : "border-amber-200 bg-amber-50 text-amber-900";
}

export function statusLabel(q: Pick<PartnerQuotation, "approval_status" | "approval_mode">): string {
    if (q.approval_status === "approved") {
        return q.approval_mode === "auto" ? "Auto-approved" : "Approved";
    }
    if (q.approval_status === "rejected") return "Rejected";
    return "Awaiting CEO";
}

export function StatusPill({ q }: { q: Pick<PartnerQuotation, "approval_status" | "approval_mode"> }) {
    return (
        <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusTone(q.approval_status)}`}
        >
            {statusLabel(q)}
        </span>
    );
}

export function PartnerQuotationsView() {
    const [tab, setTab] = useState<PartnerQuotationStatus>("pending");
    const [sending, setSending] = useState<PartnerQuotation | null>(null);

    const query = useQuery({
        queryKey: [QUOTATIONS_QUERY_KEY, tab],
        queryFn: () => fetchPartnerQuotations(tab),
        refetchInterval: 30_000,
    });

    const counts = query.data?.counts;
    const rows = query.data?.quotations ?? [];

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200">
                {TABS.map((t) => {
                    const active = t.key === tab;
                    const n = counts?.[t.key];
                    return (
                        <button
                            key={t.key}
                            type="button"
                            onClick={() => setTab(t.key)}
                            className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                                active
                                    ? "border-blue-600 text-blue-700"
                                    : "border-transparent text-gray-500 hover:text-gray-800"
                            }`}
                        >
                            {t.label}
                            {typeof n === "number" && (
                                <span
                                    className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                                        active ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-600"
                                    }`}
                                >
                                    {n}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {query.error && (
                <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-rose-600" />
                    {(query.error as Error).message}
                </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                        <tr>
                            <th className="px-4 py-2.5">Quote no.</th>
                            <th className="px-4 py-2.5">Dealer</th>
                            <th className="px-4 py-2.5">City</th>
                            <th className="px-4 py-2.5 text-right">Value</th>
                            <th className="px-4 py-2.5">Ver.</th>
                            <th className="px-4 py-2.5">Status</th>
                            <th className="px-4 py-2.5">Raised</th>
                            <th className="px-4 py-2.5">Decided</th>
                            <th className="px-4 py-2.5">Dealer</th>
                            <th className="px-4 py-2.5 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {query.isLoading && (
                            <tr>
                                <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                                    Loading…
                                </td>
                            </tr>
                        )}
                        {!query.isLoading && rows.length === 0 && (
                            <tr>
                                <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                                    {tab === "pending"
                                        ? "Nothing waiting on the CEO."
                                        : tab === "approved"
                                          ? "No approved quotations yet."
                                          : "No rejected quotations."}
                                </td>
                            </tr>
                        )}
                        {rows.map((q) => {
                            const leadHref = `/partner/lead/${encodeURIComponent(q.dealer_lead_id)}`;
                            const canSend =
                                q.approval_status === "approved" && q.is_current && Boolean(q.quote_pdf_url);
                            return (
                                <tr key={q.commercial_id} className="hover:bg-blue-50/40">
                                    <td className="px-4 py-2.5 font-mono text-xs">
                                        {q.quote_number ?? <span className="text-gray-400">—</span>}
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <Link href={leadHref} className="font-medium text-blue-700 hover:underline">
                                            {q.dealer_name || q.shop_name || "(unnamed dealer)"}
                                        </Link>
                                        {q.dealer_phone && (
                                            <div className="text-xs text-gray-500">{q.dealer_phone}</div>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-gray-700">{q.city ?? "—"}</td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">{inr.format(q.value)}</td>
                                    <td className="px-4 py-2.5 tabular-nums text-gray-600">
                                        v{q.version_no}
                                        {!q.is_current && (
                                            <span className="ml-1 text-[10px] text-gray-400">(superseded)</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <StatusPill q={q} />
                                        {q.approval_status === "rejected" && q.rejection_reason && (
                                            <div className="mt-1 max-w-xs whitespace-pre-wrap text-xs text-rose-800">
                                                {q.rejection_reason}
                                            </div>
                                        )}
                                        {q.quote_pdf_error && (
                                            <div className="mt-1 max-w-xs text-xs text-amber-800">
                                                PDF failed: {q.quote_pdf_error}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-gray-600">{fmtDate(q.created_at)}</td>
                                    <td className="px-4 py-2.5 text-gray-600">
                                        {q.approval_status === "pending" ? "—" : fmtDate(q.approved_at)}
                                        {q.approved_by_name && (
                                            <div className="text-xs text-gray-500">by {q.approved_by_name}</div>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-gray-600">
                                        {q.dealer_decision ? (
                                            <>
                                                <span className="capitalize">{q.dealer_decision}</span>
                                                <div className="text-xs text-gray-500">{fmtDate(q.dealer_decision_at)}</div>
                                            </>
                                        ) : (
                                            "—"
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <div className="flex items-center justify-end gap-2">
                                            {q.quote_pdf_url && (
                                                <a
                                                    href={q.quote_pdf_url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                                                    title="Open proforma PDF"
                                                >
                                                    <FileText className="h-3.5 w-3.5" />
                                                    PDF
                                                </a>
                                            )}
                                            {canSend && (
                                                <button
                                                    type="button"
                                                    onClick={() => setSending(q)}
                                                    className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                                                >
                                                    <Send className="h-3.5 w-3.5" />
                                                    Send
                                                </button>
                                            )}
                                            <Link
                                                href={leadHref}
                                                className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
                                            >
                                                Lead
                                                <ExternalLink className="h-3 w-3" />
                                            </Link>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {query.data?.capped && (
                <p className="text-xs text-gray-500">
                    Showing the latest 200. Open a lead for its full quotation history.
                </p>
            )}

            {sending && (
                <QuotationSendDialog
                    leadId={sending.dealer_lead_id}
                    commercialId={sending.commercial_id}
                    terms={sending.terms}
                    onClose={() => {
                        setSending(null);
                        query.refetch();
                    }}
                />
            )}
        </div>
    );
}
