import { InfoTip } from "@/components/ui/info-tip";
import { requireRole } from "@/lib/auth-utils";
import { ACCOUNT_BUCKETS } from "@/lib/dealers/accountHealthRules";
import { DealerHealthView, type DealerHealthFilter } from "./DealerHealthView";

export const dynamic = "force-dynamic";

// R-18 — converted dealers' re-order health (Requirements #5, #41).
// `?bucket=<bucket>` or `?bucket=ordering` opens the list pre-filtered (CEO overview cards link here).
export default async function DealerHealthPage({
    searchParams,
}: {
    searchParams: Promise<{ bucket?: string }>;
}) {
    await requireRole(["admin", "ceo", "sales_head", "business_head", "partner"]);
    const { bucket } = await searchParams;
    const initialBucket: DealerHealthFilter =
        bucket === "ordering" || (ACCOUNT_BUCKETS as readonly string[]).includes(bucket ?? "")
            ? (bucket as DealerHealthFilter)
            : "";

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Dealer Health</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every live dealer, by how recently it last ordered.
                    <InfoTip className="ml-1">
                        {"Every live dealer account, including dealers onboarded directly. Orders are its invoices, matched to the account's GSTIN; the owner is the account owner. Orange is the time to pitch; Red means billing must happen."}
                    </InfoTip>
                </p>
            </header>
            <DealerHealthView initialBucket={initialBucket} />
        </div>
    );
}
