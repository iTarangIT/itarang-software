"use client";

// ID 200 — under the CEO's Accounts Receivable card: where the figure comes
// from and when payments last changed. Same shared query as InvoicesReadUpTo.

import { paymentsStaleText, receivablesSourceText } from "@/lib/sales/invoiceFreshnessRules";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/ui/info-tip";

import { useInvoiceFreshness } from "./InvoicesReadUpTo";

export function ReceivablesSource({ className, compact = false }: { className?: string; compact?: boolean }) {
    const { data } = useInvoiceFreshness();
    const stale = paymentsStaleText(data);
    // C1 (wording audit, 2 Nov): on the CEO tile the source note sits behind
    // an "i"; a stale-payments warning stays on screen.
    if (compact) {
        return (
            <>
                <InfoTip label="Where this figure comes from" className={cn("ml-1", className)}>
                    {receivablesSourceText(data)}
                </InfoTip>
                {stale && <span className="block text-[11px] font-medium leading-4 text-red-600">{stale}</span>}
            </>
        );
    }
    return (
        <span className={cn("block text-[11px] leading-4 text-ink-muted", className)}>
            {receivablesSourceText(data)}
            {stale && <span className="block font-medium text-red-600">{stale}</span>}
        </span>
    );
}
