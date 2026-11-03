"use client";

// ID 200 — under the CEO's Accounts Receivable card: where the figure comes
// from and when payments last changed. Same shared query as InvoicesReadUpTo.

import { paymentsStaleText, receivablesSourceText } from "@/lib/sales/invoiceFreshnessRules";
import { cn } from "@/lib/utils";

import { useInvoiceFreshness } from "./InvoicesReadUpTo";

export function ReceivablesSource({ className }: { className?: string }) {
    const { data } = useInvoiceFreshness();
    const stale = paymentsStaleText(data);
    return (
        <span className={cn("block text-[11px] leading-4 text-ink-muted", className)}>
            {receivablesSourceText(data)}
            {stale && <span className="block font-medium text-red-600">{stale}</span>}
        </span>
    );
}
