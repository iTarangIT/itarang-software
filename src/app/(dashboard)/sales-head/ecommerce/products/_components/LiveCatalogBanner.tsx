import { Radio } from "lucide-react";

/**
 * Shown on every Ecommerce screen. Two jobs:
 *  1. Make it unmistakable that this is the LIVE Hostinger storefront, not a
 *     CRM-local staging copy — the single biggest misuse risk for this feature.
 *  2. Keep it visually distinct from the CRM's physical Inventory / Product
 *     Master module, which is a different catalog entirely.
 */
export function LiveCatalogBanner() {
    return (
        <div className="flex items-start gap-2.5 rounded-lg border border-info/30 bg-info-bg/60 px-4 py-3">
            <Radio className="mt-0.5 h-4 w-4 shrink-0 text-info" />
            <p className="text-sm text-ink">
                <span className="font-semibold">Live Hostinger storefront.</span>{" "}
                Read directly from Hostinger Ecommerce on every load — Hostinger is the
                source of truth and nothing is stored in the CRM. This is a separate
                catalog from Inventory and Product Master.
            </p>
        </div>
    );
}
