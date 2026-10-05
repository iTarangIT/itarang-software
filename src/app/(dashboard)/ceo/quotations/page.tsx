"use client";

// Quote approvals (E-221) — moved off the CEO overview, which now only counts
// them under "Needs you today". A rep cannot send a quote until the CEO acts
// on it here.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { QuotationApprovalsPanel } from "@/components/dashboard/ceo/PendingQuotationsPanel";

export default function CeoQuotationsPage() {
    return (
        <div className="space-y-6 pb-12">
            <div>
                <Link href="/ceo" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> CEO overview
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">Quote approvals</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Quotes waiting for your decision, and the ones already approved or rejected.
                </p>
            </div>
            <div className="max-w-3xl">
                <QuotationApprovalsPanel />
            </div>
        </div>
    );
}
