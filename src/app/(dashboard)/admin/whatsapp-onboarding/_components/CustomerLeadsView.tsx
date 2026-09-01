"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PartialCustomerLead } from "./types";

type Response = {
    success: true;
    data: {
        customerLeads: PartialCustomerLead[];
        total: number;
        page: number;
        limit: number;
    };
};

const INTEREST_TONE: Record<string, string> = {
    hot: "bg-danger/10 text-danger",
    warm: "bg-warning/10 text-warning",
    cold: "bg-info/10 text-info",
};

export function CustomerLeadsView() {
    const qc = useQueryClient();
    const [search, setSearch] = useState("");
    const [applied, setApplied] = useState("");
    const [page, setPage] = useState(1);

    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (applied) params.set("q", applied);

    const query = useQuery<Response>({
        queryKey: ["admin-whatsapp-customer-leads", params.toString()],
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/whatsapp-onboarding/customer-leads?${params.toString()}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load customer leads");
            return res.json();
        },
        refetchInterval: 60_000,
    });

    const rows = query.data?.data.customerLeads ?? [];
    const total = query.data?.data.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / 25));

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <div>
                    <h2 className="text-sm font-semibold text-ink">
                        Customer leads in progress
                    </h2>
                    <p className="text-xs text-ink-muted">
                        Started by a dealer over WhatsApp and not yet sent to
                        iTarang for KYC review.
                    </p>
                </div>

                <form
                    className="relative ml-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        setPage(1);
                        setApplied(search.trim());
                    }}
                >
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search customer, mobile, dealer…"
                        className="h-8 w-60 rounded-md border border-border bg-bg pl-8 pr-2 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-brand-sky"
                    />
                </form>

                {query.isFetching && (
                    <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
                )}

                <div className="ml-auto flex items-center gap-2">
                    <span className="text-xs text-ink-muted tabular-nums">
                        {total} lead{total === 1 ? "" : "s"}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        title="Refresh"
                        onClick={() =>
                            qc.invalidateQueries({
                                queryKey: ["admin-whatsapp-customer-leads"],
                            })
                        }
                    >
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {query.isError ? (
                <div className="px-4 py-8 text-sm text-danger">
                    Couldn&apos;t load customer leads.
                </div>
            ) : query.isLoading ? (
                <div className="px-4 py-10 text-center text-sm text-ink-muted">
                    Loading customer leads…
                </div>
            ) : rows.length === 0 ? (
                <div className="px-4 py-12 text-center">
                    <p className="text-sm font-medium text-ink">
                        No unfinished customer leads
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">
                        A lead appears here as soon as a dealer starts capturing
                        it on WhatsApp, and drops off once it&apos;s submitted for
                        KYC review.
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                                <th className="px-4 py-2.5 font-medium">
                                    Customer
                                </th>
                                <th className="px-4 py-2.5 font-medium">
                                    Dealer
                                </th>
                                <th className="px-4 py-2.5 font-medium">
                                    Interest
                                </th>
                                <th className="px-4 py-2.5 font-medium">
                                    Payment
                                </th>
                                <th className="px-4 py-2.5 font-medium">
                                    Documents
                                </th>
                                <th className="px-4 py-2.5 font-medium">
                                    Updated
                                </th>
                                <th className="px-4 py-2.5 font-medium text-right">
                                    Actions
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr
                                    key={r.leadId}
                                    className="border-b border-border/60 last:border-0 hover:bg-surface-muted/50"
                                >
                                    <td className="px-4 py-3 align-top">
                                        <div
                                            className={
                                                r.hasName
                                                    ? "font-medium text-ink"
                                                    : "font-medium text-ink-muted italic"
                                            }
                                        >
                                            {r.customerName}
                                        </div>
                                        <div className="mt-0.5 text-xs text-ink-muted">
                                            {r.mobile ?? "No mobile yet"}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <div className="text-xs text-ink">
                                            {r.dealerName ?? r.dealerCode ?? "—"}
                                        </div>
                                        {r.dealerName && r.dealerCode && (
                                            <div className="mt-0.5 text-xs text-ink-muted">
                                                {r.dealerCode}
                                            </div>
                                        )}
                                        {r.salespersonName && (
                                            <div className="mt-0.5 text-xs text-ink-muted">
                                                via {r.salespersonName}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        {r.interest ? (
                                            <span
                                                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                                                    INTEREST_TONE[
                                                        r.interest.toLowerCase()
                                                    ] ??
                                                    "bg-ink-muted/10 text-ink-muted"
                                                }`}
                                            >
                                                {r.interest}
                                            </span>
                                        ) : (
                                            <span className="text-xs text-ink-muted">
                                                —
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-top text-xs text-ink capitalize">
                                        {r.paymentMethod?.replaceAll("_", " ") ??
                                            "—"}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <span className="tabular-nums text-ink">
                                            {r.docsUploaded}
                                        </span>
                                        {r.docTypes.length > 0 && (
                                            <div
                                                className="mt-0.5 max-w-[200px] truncate text-xs text-ink-muted"
                                                title={r.docTypes.join(", ")}
                                            >
                                                {r.docTypes
                                                    .map((t) =>
                                                        t.replaceAll("_", " "),
                                                    )
                                                    .join(", ")}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-top text-xs text-ink-muted">
                                        {new Date(
                                            r.updatedAt,
                                        ).toLocaleDateString()}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <div className="flex justify-end">
                                            <a
                                                href={`/admin/kyc-review/${r.leadId}`}
                                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                            >
                                                <ExternalLink className="h-3.5 w-3.5" />
                                                Open lead
                                            </a>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {pages > 1 && (
                <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
                    <span className="text-xs text-ink-muted">
                        Page {page} of {pages}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                        Previous
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= pages}
                        onClick={() => setPage((p) => p + 1)}
                    >
                        Next
                    </Button>
                </div>
            )}
        </div>
    );
}
