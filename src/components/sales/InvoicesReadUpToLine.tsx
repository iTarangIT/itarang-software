// ID 171 — "Invoices read up to <date>": the caption under revenue and battery
// numbers. Presentational only (no hooks), so server pages render it with the
// data they read and InvoicesReadUpTo fetches it for client screens.

import { Clock } from "lucide-react";

import { readUpToText, staleAlertText, type InvoiceFreshness } from "@/lib/sales/invoiceFreshnessRules";
import { cn } from "@/lib/utils";

export function InvoicesReadUpToLine({ f, className }: { f: InvoiceFreshness | null | undefined; className?: string }) {
    if (!f) return null;
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 text-[11px] leading-4",
                f.stale ? "font-semibold text-amber-700" : "text-ink-muted",
                className,
            )}
            title={
                staleAlertText(f) ??
                `Latest invoice the CRM has read. Revenue and batteries include invoices up to this date. Alert after ${f.stale_after} working days with no new invoice.`
            }
        >
            <Clock aria-hidden className="h-3 w-3 shrink-0" />
            {readUpToText(f)}
        </span>
    );
}
