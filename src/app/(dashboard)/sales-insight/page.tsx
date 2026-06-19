import Link from "next/link";
import { Upload } from "lucide-react";
import { requireRole } from "@/lib/auth-utils";
import { ConvertedInsightView } from "./_components/ConvertedInsightView";

export const dynamic = "force-dynamic";

export default async function SalesInsightDashboard() {
    const user = await requireRole([
        "sales_insight",
        "sales_manager",
        "sales_head",
        "business_head",
        "ceo",
    ]);

    return (
        <div className="p-8 space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Sales Insight</h1>
                    <p className="text-muted-foreground">
                        Welcome back, {user.name}. Every converted lead across the AI dialer and B2B pipelines.
                    </p>
                </div>
                <Link
                    href="/sales-insight/upload"
                    className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                    <Upload className="h-4 w-4" />
                    Upload Leads
                </Link>
            </div>
            <ConvertedInsightView />
        </div>
    );
}
