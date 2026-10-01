// The "Won without an approved quote" chip (tracker ID 74).
//
// Mark Won is allowed before the dealer has approved a quote — and flagged
// (dealer_leads.won_without_approved_quote, E-314). The caller decides whether
// to render it: use wonWithoutQuote() from @/lib/inside-sales/types, which
// gates the flag on the Won / Converted status it describes.
//
// Amber: a thing to look at, not an error.

export function WonWithoutQuoteChip({ className = "" }: { className?: string }) {
    return (
        <span
            title="Marked Won with no dealer-approved quote on the lead."
            className={`inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 ${className}`}
        >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            No approved quote
        </span>
    );
}
