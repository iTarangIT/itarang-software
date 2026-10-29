"use client";

// E-358 — the account page in My Dealers: who the account is, and its account
// quotations (create / send / track). A 403 from the API is shown as such:
// an account you are not assigned to is not yours to quote.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Camera, Loader2 } from "lucide-react";

import { AccountQuotationsPanel } from "@/components/accounts/AccountQuotations";
import type { AccountSummary } from "@/lib/accounts/quotations/access";

export function AccountPageView({ accountId }: { accountId: string }) {
    const { data, isLoading, error } = useQuery<{ account: AccountSummary; can_create: boolean }>({
        queryKey: ["dealer-account", accountId],
        queryFn: async () => {
            const res = await fetch(`/api/dealer-accounts/${encodeURIComponent(accountId)}`, { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load this account");
            return json.data;
        },
        retry: false,
    });

    return (
        <>
            <Link href="/my-dealers" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" /> My dealers
            </Link>
            {isLoading && (
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            )}
            {error && (
                <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-rose-600">
                    {(error as Error).message}
                </p>
            )}
            {data && (
                <>
                    <header className="rounded-xl border border-border bg-surface px-4 py-4 shadow-card">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                                <h1 className="text-xl font-semibold tracking-tight text-ink">{data.account.name}</h1>
                                <p className="font-mono text-xs text-ink-muted">{data.account.id}</p>
                            </div>
                            {/* ID 196: a verified visit on this counter (owner or their manager). */}
                            {data.can_create && (
                                <Link
                                    href={`/visits/capture?account=${encodeURIComponent(accountId)}`}
                                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink hover:bg-gray-50"
                                >
                                    <Camera className="h-4 w-4" /> Log visit
                                </Link>
                            )}
                        </div>
                        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                            <div>
                                <dt className="text-[11px] uppercase tracking-wide text-ink-muted">GSTIN</dt>
                                <dd className="text-ink">{data.account.gstin || "—"}</dd>
                            </div>
                            <div>
                                <dt className="text-[11px] uppercase tracking-wide text-ink-muted">Owner</dt>
                                <dd className="text-ink">{data.account.owner_name ?? "No owner"}</dd>
                            </div>
                            <div>
                                <dt className="text-[11px] uppercase tracking-wide text-ink-muted">Location</dt>
                                <dd className="text-ink">{[data.account.city, data.account.state].filter(Boolean).join(", ") || "—"}</dd>
                            </div>
                            <div>
                                <dt className="text-[11px] uppercase tracking-wide text-ink-muted">Contact</dt>
                                <dd className="text-ink">
                                    {[data.account.contact_name, data.account.contact_phone, data.account.contact_email].filter(Boolean).join(" · ") || "—"}
                                </dd>
                            </div>
                        </dl>
                    </header>
                    <AccountQuotationsPanel accountId={accountId} />
                </>
            )}
        </>
    );
}
