import { requireRole } from "@/lib/auth-utils";
import { UploadWizard } from "./_components/UploadWizard";
import { UploadBatchList } from "./_components/UploadBatchList";

export const dynamic = "force-dynamic";

// BRD §0.4 — admin bulk CSV upload. Admin-only.
export default async function AdminUploadPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-6 max-w-[1200px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Bulk Lead Upload
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Upload a dealer-prospect CSV (max 5 MB / 5000 rows). Required
                    columns: phone, dealer_name, city, state.
                </p>
            </header>
            <UploadWizard />
            <UploadBatchList />
        </div>
    );
}
