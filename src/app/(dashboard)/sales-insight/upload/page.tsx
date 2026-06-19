import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/auth-utils";
import { UploadWizard } from "../../admin/upload/_components/UploadWizard";
import { UploadBatchList } from "../../admin/upload/_components/UploadBatchList";

export const dynamic = "force-dynamic";

// Bulk CSV/Excel lead upload for the Sales Insight workspace. Reuses the same
// hardened wizard, validation, dedupe and 24h-rollback pipeline as /admin/upload
// — only the host page and the route role-gate differ.
export default async function SalesInsightUploadPage() {
    await requireRole([
        "sales_insight",
        "sales_manager",
        "sales_head",
        "business_head",
        "ceo",
    ]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-6 max-w-[1200px]">
            <header>
                <Link
                    href="/sales-insight"
                    className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to Sales Insight
                </Link>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
                    Bulk Lead Upload
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Upload a dealer-prospect CSV or Excel file (max 5 MB /
                    5000 rows). Required columns: phone, dealer_name, city, state.
                </p>
            </header>
            <UploadWizard />
            <UploadBatchList />
        </div>
    );
}
